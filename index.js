/**
 * Host companion for the page-translate bundle.
 *
 * Two HTTP routes the Client half calls from the renderer:
 *
 * - `/page-translate/translate` proxies Google's web translation endpoint
 *   (free, no key, bounded concurrency) and falls back to the Harness
 *   translation service when Google is unreachable.
 * - `/page-translate/model` translates with the Harness default model through
 *   `ctx.llm.stream`, sending the page context so ambiguous words are resolved
 *   per page (theme-aware). It consumes the account's model quota and is the
 *   opt-in engine of the plugin.
 *
 * Both routes live on the DSH web server (loopback-bound) and answer CORS so
 * the renderer's fetch works regardless of its origin.
 */
const ROUTE_PATH = '/page-translate/translate'
const MODEL_ROUTE_PATH = '/page-translate/model'
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const MAX_TEXTS = 40
const MAX_CHARS = 4000
const MAX_BODY_BYTES = 256 * 1024
const CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 12000

const MODEL_SYSTEM = [
  'You are a precise bilingual translator.',
  'The user message is a JSON object with "to" (target language), "context" (the page title and',
  'opening text, for disambiguation) and "texts" (strings to translate).',
  'Translate every string into the target language. Use the page context to pick the right sense of',
  'ambiguous words and to match the page domain vocabulary (for example film photography vs cinema).',
  'Keep markers like ⟦G0⟧ unchanged: they stand for glossary terms and are restored after translation.',
  'Preserve code, URLs, file paths, commands, versions and product names verbatim.',
  'Return ONLY a JSON array of translated strings, same length and order as "texts".',
  'No commentary, no markdown fences, no extra keys.',
].join(' ')

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...CORS,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Map the UI language tag onto the code the web endpoint expects. */
function googleLanguage(tag) {
  const lower = String(tag === undefined || tag === null ? '' : tag).toLowerCase()
  if (lower === '' || lower === 'zh' || lower === 'zh-cn' || lower === 'zh-sg' || lower === 'zh-hans') return 'zh-CN'
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') return 'zh-TW'
  return tag
}

/** Translate one string through Google's web endpoint. */
async function translateGoogle(text, to) {
  const url = GOOGLE_ENDPOINT
    + '?client=gtx&sl=auto&tl=' + encodeURIComponent(googleLanguage(to)) + '&dt=t&q=' + encodeURIComponent(text)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    const payload = await response.json()
    const segments = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : []
    let translated = ''
    for (const segment of segments) {
      if (Array.isArray(segment) && typeof segment[0] === 'string') translated += segment[0]
    }
    if (translated === '') throw new Error('empty translation')
    return translated
  } finally {
    clearTimeout(timer)
  }
}

/** Pull the JSON array of translations out of a model reply. */
function parseModelTranslations(raw, expected) {
  const text = String(raw === undefined || raw === null ? '' : raw)
  const candidates = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) candidates.push(fence[1])
  for (const candidate of candidates) {
    const start = candidate.indexOf('[')
    const end = candidate.lastIndexOf(']')
    if (start < 0 || end <= start) continue
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      if (Array.isArray(parsed) && parsed.length === expected && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch (_error) {
      // Try the next candidate.
    }
  }
  return null
}

/** Read and validate the shared request body of both routes. */
function readRequest(body) {
  const texts = Array.isArray(body !== null && typeof body === 'object' ? body.texts : null)
    ? body.texts
      .filter((text) => typeof text === 'string' && text.trim() !== '')
      .slice(0, MAX_TEXTS)
      .map((text) => text.slice(0, MAX_CHARS))
    : []
  const to = typeof body.to === 'string' && body.to !== '' ? body.to : 'zh-CN'
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  const context = typeof body.context === 'string' ? body.context.slice(0, 1500) : ''
  return { texts, to, sessionId, context }
}

/**
 * Mount the translation routes.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
  const googleHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method' })
        return
      }
      const { texts, to } = readRequest(await readBody(req))
      if (texts.length === 0) {
        send(res, 400, { error: 'empty' })
        return
      }
      const results = new Array(texts.length).fill('')
      let provider = null
      const translator = ctx.get('translator')
      let index = 0
      const lane = async () => {
        for (;;) {
          const current = index
          index += 1
          if (current >= texts.length) return
          const text = texts[current]
          try {
            results[current] = await translateGoogle(text, to)
            provider = 'google'
            continue
          } catch (_error) {
            // Fall through to the Harness translator.
          }
          if (translator === undefined) continue
          for (const candidate of ['google', 'bing']) {
            try {
              const translated = await translator.translate(translator.resolve({ text, targetLanguage: to, provider: candidate }))
              if (typeof translated === 'string' && translated !== '') {
                results[current] = translated
                provider = candidate
                break
              }
            } catch (_error) {
              // Try the next provider.
            }
          }
        }
      }
      await Promise.all([lane(), lane(), lane(), lane()])
      send(res, 200, { translations: results, provider })
    } catch (_error) {
      try {
        send(res, 500, { error: 'failed' })
      } catch (_ignored) {
        // Response already gone.
      }
    }
  }

  const modelHandler = async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method' })
        return
      }
      const { texts, to, sessionId, context } = readRequest(await readBody(req))
      if (texts.length === 0) {
        send(res, 400, { error: 'empty' })
        return
      }
      const llm = ctx.get('llm')
      const defaults = ctx.get('agentDefaultModel')
      if (llm === undefined || defaults === undefined) {
        send(res, 503, { error: 'model unavailable' })
        return
      }
      let selection
      try {
        selection = defaults.currentSelection()
      } catch (_error) {
        send(res, 503, { error: 'model unavailable' })
        return
      }
      const provider = selection !== null && typeof selection === 'object' && typeof selection.provider === 'string'
        ? selection.provider
        : ''
      const modelId = selection !== null && typeof selection === 'object' && typeof selection.model === 'string'
        ? selection.model
        : ''
      if (provider === '' || modelId === '') {
        send(res, 503, { error: 'model unavailable' })
        return
      }
      const prompt = JSON.stringify({ to, context, texts })
      const maxTokens = Math.max(512, Math.min(4096, 256 + Math.ceil(texts.join('').length * 2.4)))
      const options = {
        provider,
        model: modelId,
        system: MODEL_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.2,
        maxTokens,
      }
      if (sessionId !== undefined) options.sessionId = sessionId
      let text = ''
      let failure = null
      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk === null || typeof chunk !== 'object') continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object'
            && chunk.reason.kind === 'error' && chunk.reason.failure !== null) {
            failure = chunk.reason.failure
          } else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object'
            && chunk.reason.kind === 'aborted') {
            failure = { message: 'aborted' }
          }
        }
      } catch (error) {
        send(res, 502, { error: 'model failed', detail: String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 200) })
        return
      }
      const translations = parseModelTranslations(text, texts.length)
      if (translations === null) {
        send(res, 502, {
          error: 'bad format',
          detail: failure !== null && typeof failure === 'object' && typeof failure.message === 'string' ? failure.message.slice(0, 200) : '',
        })
        return
      }
      send(res, 200, { translations, provider: provider + '/' + modelId })
    } catch (_error) {
      try {
        send(res, 500, { error: 'failed' })
      } catch (_ignored) {
        // Response already gone.
      }
    }
  }

  ctx.effect(() => {
    const disposeGoogle = ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: googleHandler })
    const disposeModel = ctx.webServer.register({ kind: 'exact', path: MODEL_ROUTE_PATH, handler: modelHandler })
    return () => {
      disposeGoogle()
      disposeModel()
    }
  }, 'page-translate: translate routes')
}

export const inject = ['webServer']
