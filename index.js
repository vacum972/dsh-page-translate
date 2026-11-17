/**
 * Host companion for the page-translate bundle.
 *
 * Exposes one small HTTP route the Client half calls for better translation
 * than the anonymous Bing endpoint. Google's web translation endpoint answers
 * plain HTTP requests without a key and is reachable from the Host process, so
 * the route proxies it with bounded concurrency. When Google is unreachable it
 * falls back to the Harness translation service if that service is loaded.
 */
const ROUTE_PATH = '/page-translate/translate'
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const MAX_TEXTS = 40
const MAX_CHARS = 4000
const MAX_BODY_BYTES = 256 * 1024
const CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 12000

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

/**
 * Mount the translation route.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
  const handler = async (req, res) => {
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
      const body = await readBody(req)
      const texts = Array.isArray(body !== null && typeof body === 'object' ? body.texts : null)
        ? body.texts
          .filter((text) => typeof text === 'string' && text.trim() !== '')
          .slice(0, MAX_TEXTS)
          .map((text) => text.slice(0, MAX_CHARS))
        : []
      if (texts.length === 0) {
        send(res, 400, { error: 'empty' })
        return
      }
      const to = typeof body.to === 'string' && body.to !== '' ? body.to : 'zh-CN'
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
            // Fall through to the Harness translator when Google refuses.
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
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }), 'page-translate: translate route')
}

export const inject = ['webServer']
