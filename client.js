/**
 * Browser half of the page-translate bundle.
 *
 * Adds page translation to the right-Sidebar Browser in two places:
 * an always-visible launcher button in the panel's chrome strip, and an entry
 * in the tab's actions menu. Block-level text is collected from the guest
 * document, translated in batches, and inserted under each source block the
 * way browser translation extensions do; activating it again removes the
 * inserted copy.
 *
 * Translation uses Microsoft's Edge translation endpoint, the same anonymous
 * endpoint the Harness translation service uses by default. That endpoint
 * allows cross-origin requests (`Access-Control-Allow-Origin: *`) and accepts
 * an array of source strings, so this plugin needs no Host route, credential,
 * or session record: the Desktop renderer calls it directly.
 *
 * The page work uses the Electron `<webview>` hosted by
 * `@deepseek-ai/dsh-client-ui-sidebar-browser`. Web profiles render that Browser
 * with a cross-origin `<iframe>`, which cannot be injected, so the launcher and
 * the menu action report themselves unavailable there.
 */
window.__ModuleLoader__.load({
  id: '@local/page-translate',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'page-translate';
    /** Right-Sidebar Browser tab kind. */
    const BROWSER_KIND = 'browser';
    /** The Browser package's Electron guest element, marked by the owner. */
    const VIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]';
    /** Right-Sidebar panel marker. */
    const PANEL_SELECTOR = '[data-sidebar-right-session]';
    /** Our own mount inside the panel chrome strip; used to exclude it while locating that strip. */
    const LAUNCHER_MOUNT_ATTR = 'data-page-translate-mount';
    /** Anonymous Microsoft Edge translation endpoint. */
    const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';
    /** Source strings per request. */
    const BATCH_TEXTS = 12;
    /** Source characters per request. */
    const BATCH_CHARS = 2800;
    /** Requests in flight at once. */
    const CONCURRENCY = 2;
    /** Deadline for one endpoint request. */
    const REQUEST_TIMEOUT_MS = 20000;
    /** Blocks collected per activation. */
    const MAX_BLOCKS = 240;
    /** Characters collected per activation. */
    const MAX_CHARS = 80000;
    /** How long the settled page notice stays visible. */
    const NOTICE_MS = 2600;
    /** Translation memory cap for one Client session. */
    const CACHE_LIMIT = 4000;
    /** localStorage key of the per-origin auto-translate preferences. */
    const AUTO_KEY = 'dsh.page-translate.auto-sites';
    /** Delay after a page load before an automatic translation starts. */
    const AUTO_DELAY_MS = 700;
    /** Preferred translation engine: the Host route (model/Google chain) or Bing. */
    const ENGINE_KEY = 'dsh.page-translate.engine';
    const TRANSLATE_ROUTE = '/page-translate/translate';
    let enginePreference = readEnginePreference();
    /** Session id of the Chat the menu was opened from; enables the paid route. */
    let activeSessionId = null;

    const zh = {
      'menu.translate': '翻译此页',
      'menu.restore': '显示原文（移除译文）',
      'menu.unavailable': '当前页面无法翻译',
      'launcher.translate': '翻译此页',
      'launcher.restore': '显示原文（移除译文）',
      'status.preparing': '正在识别页面段落…',
      'status.translating': '正在翻译 {done}/{total}',
      'status.done': '已翻译 {count} 段',
      'status.partial': '翻译完成，{failed}/{total} 段失败',
      'status.empty': '没有找到可翻译的文本',
      'status.failed': '翻译失败：{reason}',
      'status.busy': '页面正在加载或已跳转，请稍后重试',
      'a11y.translate': '把此页翻译成双语',
      'a11y.restore': '移除插入的译文',
      'auto.on': '本站自动翻译：开',
      'auto.off': '本站自动翻译：关',
      'auto.a11y': '切换本站自动翻译',
      'engine.route': '翻译引擎：模型优先（DeepSeek/Google）',
      'engine.bing': '翻译引擎：Bing 直连',
      'engine.a11y': '切换翻译引擎',
    };

    const en = {
      'menu.translate': 'Translate this page',
      'menu.restore': 'Show original (remove translations)',
      'menu.unavailable': 'This page cannot be translated',
      'launcher.translate': 'Translate this page',
      'launcher.restore': 'Show original (remove translations)',
      'status.preparing': 'Scanning page blocks…',
      'status.translating': 'Translating {done}/{total}',
      'status.done': 'Translated {count} blocks',
      'status.partial': 'Translated with {failed}/{total} failures',
      'status.empty': 'No translatable text found',
      'status.failed': 'Translation failed: {reason}',
      'status.busy': 'The page is loading or navigated; try again in a moment',
      'a11y.translate': 'Translate this page into bilingual blocks',
      'a11y.restore': 'Remove the inserted translations',
      'auto.on': 'Auto-translate this site: on',
      'auto.off': 'Auto-translate this site: off',
      'auto.a11y': 'Toggle automatic translation for this site',
      'engine.route': 'Engine: model first (DeepSeek/Google)',
      'engine.bing': 'Engine: Bing direct',
      'engine.a11y': 'Switch translation engine',
    };

    /** Style for the tab-menu row; matches the kit's menu rows. */
    const MENU_CSS = [
      '.pt-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;',
      'padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
      '.pt-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.pt-menu-item:disabled{color:var(--dsw-alias-label-quaternary);cursor:default;background:transparent}',
      '.pt-menu-item .pt-icon{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.pt-menu-item:disabled .pt-icon{color:var(--dsw-alias-label-quaternary)}',
    ].join('');

    /** Style for the in-strip launcher; matches the panel chrome icon buttons. */
    const LAUNCHER_CSS = [
      '.pt-launcher{display:inline-flex;align-items:center;justify-content:center;flex:none;',
      'width:28px;height:28px;padding:0;border:0;border-radius:3px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.pt-launcher:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.pt-launcher:active{background:var(--dsw-alias-interactive-bg-pressed,var(--dsw-alias-interactive-bg-hover))}',
      '.pt-launcher[data-busy=true]{color:var(--dsw-alias-label-primary);opacity:.65;cursor:default}',
      '.pt-launcher svg{display:block}',
    ].join('');

    // #region page-side scripts
    // `pageTranslateInstall` and `pageTranslateCollect` are serialized with
    // `Function.prototype.toString` and evaluated inside the visited page, so
    // they must stay self-contained: page globals only, no outer identifiers.

    /**
     * Install the page-side receiver and progress notice. Idempotent.
     *
     * Insertion is deliberately minimal: a translation is appended as a plain
     * block child of its source element and, when that child is squeezed by a
     * flex/grid layout, dropped rather than relocated. No page element has its
     * own inline style changed, so the surrounding layout can never be altered.
     */
    function pageTranslateInstall() {
      if (window.__dshPT && window.__dshPT.version === 23) return 'present';
      var STYLE_ATTR = 'data-dsh-pt-style';
      var OVERLAY_ATTR = 'data-dsh-pt-overlay';
      var TRANS_ATTR = 'data-dsh-pt-trans';
      var MARK_ATTR = 'data-dsh-pt';
      var HASH_ATTR = 'data-dsh-pt-hash';
      var RUN_ATTR = 'data-dsh-pt-run';
      var DONE_ATTR = 'data-dsh-pt-done';
      var TRANS_SELECTOR = '[' + TRANS_ATTR + ']';
      var currentRun = '';
      var dirtyFlag = false;
      var CSS = [
        '.dsh-pt-translation{display:block;width:100%;box-sizing:border-box;margin:.28em 0 0;',
        'padding-left:.55em;border-left:2px solid #e5484d;text-decoration:none;',
        'font:inherit;font-size:.95em;line-height:1.65;color:inherit;',
        'white-space:normal;word-break:break-word;overflow-wrap:anywhere;',
        'text-align:inherit;direction:inherit}',
        '.dsh-pt-inline{display:inline;margin-left:.35em;padding-left:.35em;',
        'border-left:2px solid #e5484d;text-decoration:none;font:inherit;font-size:.95em;',
        'color:inherit;white-space:normal}',
      ].join('');

      function ensureStyle() {
        if (document.querySelector('[' + STYLE_ATTR + ']') !== null) return;
        var style = document.createElement('style');
        style.setAttribute(STYLE_ATTR, '1');
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
      }

      function remove(node) {
        if (node !== null && node !== undefined && node.parentNode !== null) node.parentNode.removeChild(node);
      }

      function overlay() {
        var node = document.querySelector('[' + OVERLAY_ATTR + ']');
        if (node !== null) return node;
        node = document.createElement('div');
        node.setAttribute(OVERLAY_ATTR, '1');
        node.style.cssText = [
          'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:280px;',
          'padding:8px 12px;border-radius:10px;background:rgba(24,26,30,.92);color:#f5f6f8;',
          'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;',
          'box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;white-space:pre-wrap',
        ].join('');
        document.documentElement.appendChild(node);
        return node;
      }

      /** Stable short hash of a source text. */
      function textHash(text) {
        var hash = 5381;
        for (var i = 0; i < text.length; i += 1) {
          hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
        }
        return hash.toString(36);
      }

      /** Locate the element a translation belongs to, refusing stale targets. */
      function findTarget(item) {
        if (item.run !== currentRun) return null;
        var byId = document.querySelector('[' + MARK_ATTR + '="' + String(item.id) + '"]');
        if (byId !== null && byId.getAttribute(RUN_ATTR) === item.run && byId.getAttribute(HASH_ATTR) === item.hash) {
          return byId;
        }
        // A re-render may have renumbered the marks; the text hash still names
        // the same element, so recover it instead of writing a wrong line.
        var pool = document.querySelectorAll('[' + RUN_ATTR + '="' + item.run + '"][' + HASH_ATTR + '="' + item.hash + '"]');
        for (var i = 0; i < pool.length; i += 1) {
          if (pool[i].querySelector('[' + TRANS_ATTR + ']') === null) return pool[i];
        }
        return null;
      }

      function applyOne(item) {
        var target = findTarget(item);
        if (target === null) return false;
        // Remove this target's previous translations, including any nested ones.
        var previous = target.querySelectorAll('[' + TRANS_ATTR + ']');
        for (var p = previous.length - 1; p >= 0; p -= 1) remove(previous[p]);        var inline = item.inline === true;
        var span = document.createElement('span');
        span.setAttribute(TRANS_ATTR, '1');
        span.className = inline ? 'dsh-pt-inline' : 'dsh-pt-translation';
        span.setAttribute('dir', 'auto');
        span.textContent = item.text;
        if (inline) {
          // Keep the label line intact: sit after the text but before a trailing
          // icon (a heading arrow, an external-link glyph, ...).
          var last = target.lastElementChild;
          if (last !== null && last.tagName === 'SVG') target.insertBefore(span, last);
          else target.appendChild(span);
          target.setAttribute(DONE_ATTR, '1');
          return true;
        }
        target.appendChild(span);
        // A flex/grid cell can squeeze the block into a one-character column;
        // drop that translation rather than let it distort the page.
        var rect = span.getBoundingClientRect();
        var length = span.textContent ? span.textContent.length : 0;
        if (length >= 4 && rect.width > 0 && rect.width < 48) remove(span);
        else target.setAttribute(DONE_ATTR, '1');
        return true;
      }

      // Watch for content the page adds later (infinite scroll, lazy cards) and
      // report it to the Client, which translates it incrementally.
      var observer = null;
      if (window.__dshPT && window.__dshPT.__observer) {
        try {
          window.__dshPT.__observer.disconnect();
        } catch (_error) {
          // Old observer already gone.
        }
      }
      observer = new MutationObserver(function (records) {
        for (var r = 0; r < records.length; r += 1) {
          var targetNode = records[r].target;
          if (targetNode !== null && targetNode.nodeType === 1
            && (targetNode.hasAttribute(OVERLAY_ATTR) || targetNode.closest('[' + OVERLAY_ATTR + ']') !== null)) {
            continue;
          }
          var added = records[r].addedNodes;
          for (var a = 0; a < added.length; a += 1) {
            var node = added[a];
            if (node !== null && node.nodeType === 1
              && (node.hasAttribute(TRANS_ATTR) || node.hasAttribute(OVERLAY_ATTR) || node.hasAttribute(STYLE_ATTR))) {
              continue;
            }
            dirtyFlag = true;
          }
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

      window.__dshPT = {
        version: 23,
        __observer: observer,
        dirty: function () {
          var value = dirtyFlag;
          dirtyFlag = false;
          return value;
        },
        begin: function (run) {
          currentRun = String(run);
          // Drop marks left by an earlier run; they must not hide elements from
          // this run's collection.
          var stale = document.querySelectorAll('[' + MARK_ATTR + ']');
          for (var i = 0; i < stale.length; i += 1) {
            if (stale[i].getAttribute(RUN_ATTR) === currentRun) continue;
            stale[i].removeAttribute(MARK_ATTR);
            stale[i].removeAttribute(HASH_ATTR);
            stale[i].removeAttribute(RUN_ATTR);
          }
        },
        hash: textHash,
        count: function () {
          return document.querySelectorAll(TRANS_SELECTOR).length;
        },
        status: function (message) {
          ensureStyle();
          var node = overlay();
          node.textContent = String(message);
          node.style.display = 'block';
        },
        hide: function () {
          remove(document.querySelector('[' + OVERLAY_ATTR + ']'));
        },
        clear: function () {
          var translations = document.querySelectorAll(TRANS_SELECTOR);
          for (var i = translations.length - 1; i >= 0; i -= 1) remove(translations[i]);
          var done = document.querySelectorAll('[' + DONE_ATTR + ']');
          for (var d = 0; d < done.length; d += 1) done[d].removeAttribute(DONE_ATTR);
          var marked = document.querySelectorAll('[' + MARK_ATTR + ']');
          for (var j = 0; j < marked.length; j += 1) {
            marked[j].removeAttribute(MARK_ATTR);
            marked[j].removeAttribute(HASH_ATTR);
            marked[j].removeAttribute(RUN_ATTR);
          }
          remove(document.querySelector('[' + STYLE_ATTR + ']'));
          remove(document.querySelector('[' + OVERLAY_ATTR + ']'));
        },
        apply: function (items) {
          if (items === null || typeof items !== 'object' || typeof items.length !== 'number') return 0;
          ensureStyle();
          var applied = 0;
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            if (item === null || typeof item !== 'object') continue;
            if (typeof item.text !== 'string' || item.text === '') continue;
            if (applyOne(item)) applied += 1;
          }
          return applied;
        },
      };
      return 'ready';
    }

    /**
     * Collect only safe text blocks. Divs and interactive controls are not
     * targeted, flex/grid/inline boxes are skipped, and navigation/header chrome
     * is excluded, so a translation is always a plain block child of a plain
     * block element and can never collapse a site's own layout.
     */
    function pageTranslateCollect(options) {
      var MARK_ATTR = 'data-dsh-pt';
      var HASH_ATTR = 'data-dsh-pt-hash';
      var RUN_ATTR = 'data-dsh-pt-run';
      var DONE_ATTR = 'data-dsh-pt-done';
      var TRANS_ATTR = 'data-dsh-pt-trans';
      var BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,div';
      var SKIP_SELECTOR = [
        'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp',
        'textarea', 'select', 'option', 'button', 'svg', 'canvas', 'video', 'audio',
        'iframe', 'object', 'embed', '[contenteditable="true"]', '[aria-hidden="true"]',
        '[' + TRANS_ATTR + ']',
      ].join(',');
      var SKIP_TAGS = {
        SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1,
        TEXTAREA: 1, SELECT: 1, OPTION: 1, BUTTON: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1,
      };
      var HIDDEN_TEXT_SELECTOR = [
        'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp',
        'textarea', 'select', 'option', 'svg', 'canvas', 'video', 'audio', 'iframe',
        'object', 'embed', '[aria-hidden="true"]', '[hidden]', '[role="tooltip"]',
        '[' + TRANS_ATTR + ']',
        '.sr-only', '.visually-hidden', '.visuallyhidden', '.screen-reader-text', '.a11y-hidden',
        '[class*="VisuallyHidden" i]', '[class*="visually-hidden" i]', '[class*="sr-only" i]',
        '[class*="screen-reader" i]', '[data-component*="VisuallyHidden" i]',
        '[data-component="Tooltip" i]',
      ].join(',');
      var opts = options === null || typeof options !== 'object' ? {} : options;
      var target = String(opts.target === undefined ? '' : opts.target).toLowerCase();
      var run = String(opts.run === undefined ? '' : opts.run);
      var maxBlocks = typeof opts.maxBlocks === 'number' ? opts.maxBlocks : 200;
      var maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : 60000;
      var body = document.body;
      if (body === null) return { ok: false, blocks: [], reason: 'no-body' };

      /** Stable short hash of a source text. */
      function textHash(text) {
        var hash = 5381;
        for (var i = 0; i < text.length; i += 1) {
          hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
        }
        return hash.toString(36);
      }

      function textOf(element) {
        var out = '';
        var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
        var node = walker.nextNode();
        while (node !== null) {
          var parent = node.parentElement;
          if (parent !== null) {
            var blocked = parent.closest(HIDDEN_TEXT_SELECTOR);
            if (blocked !== null && blocked !== element) {
              node = walker.nextNode();
              continue;
            }
            if (parent !== element && parent.tagName.indexOf('-') !== -1) {
              node = walker.nextNode();
              continue;
            }
            if (parent !== element && SKIP_TAGS[parent.tagName]) {
              node = walker.nextNode();
              continue;
            }
            var value = node.nodeValue;
            if (value) out += value + ' ';
          }
          node = walker.nextNode();
        }
        return out.replace(/\s+/g, ' ').trim();
      }

      function alreadyTarget(text) {
        var cjk = 0;
        var latin = 0;
        for (var i = 0; i < text.length; i += 1) {
          var code = text.charCodeAt(i);
          if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
          else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
        }
        var letters = cjk + latin;
        if (letters < 3) return true;
        if (target.indexOf('zh') === 0) return cjk / letters > 0.6;
        if (target.indexOf('en') === 0) return cjk / letters < 0.05 && latin / letters > 0.85;
        return false;
      }

      function looksLikeIdentifier(text) {
        if (text.indexOf(' ') !== -1 || text.length > 48) return false;
        return /[0-9]/.test(text) && /[A-Za-z]/.test(text);
      }

      function hidden(element) {
        var rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return true;
        var style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
        if (style.clip && style.clip !== 'auto') return true;
        if (style.clipPath === 'inset(50%)') return true;
        if (style.position === 'absolute' && rect.width <= 2 && rect.height <= 2) return true;
        return false;
      }

      function inViewport(element) {
        var rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < (window.innerHeight || 800) && rect.width > 0 && rect.height > 0;
      }

      function safeDisplay(element) {
        var style = window.getComputedStyle(element);
        var display = style.display;
        if (display === 'contents') return false;
        if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) return false;
        if (display === 'inline') return false;
        return true;
      }

      /**
       * Wide sticky/fixed bars, top navigation and header chrome are measured by
       * the site itself and must not receive translated lines. Narrow side
       * columns — a sidebar or a vertical navigation list — are allowed, so the
       * sidebar can be translated while the top bar stays untouched.
       */
      function chromeRegion(element) {
        var viewport = window.innerWidth || 1200;
        var node = element;
        var hops = 0;
        while (node !== null && node !== body && hops < 10) {
          var tag = node.tagName;
          var role = node.getAttribute('role');
          if (role === 'tablist' || role === 'menu') return true;
          var rect = node.getBoundingClientRect();
          if (rect.width < viewport * 0.45) {
            node = node.parentElement;
            hops += 1;
            continue;
          }
          var style = window.getComputedStyle(node);
          if (style.position === 'sticky' || style.position === 'fixed') return true;
          // Article internals are content: an article's own header, eyebrow or
          // byline wrappers must not be treated as site chrome.
          if (node.closest('article') !== null) {
            node = node.parentElement;
            hops += 1;
            continue;
          }
          if (tag === 'NAV' || role === 'navigation' || tag === 'FOOTER' || role === 'contentinfo') return true;
          var cls = node.getAttribute('class');
          var outsideMain = node.closest('main, [role="main"]') === null;
          if (outsideMain && cls !== null
            && /(header|breadcrumb|navigation|UnderlineNav|NavItem|navbar|toolbar)/i.test(cls)) return true;
          if (tag === 'HEADER' || role === 'banner') {
            // Inside the content area this is a section/article header, not the
            // site header; only the wide page-level header is chrome.
            if (outsideMain) return true;
          }
          node = node.parentElement;
          hops += 1;
        }
        return false;
      }

      /** Whether the element owns a non-empty text node directly. */
      function hasDirectText(element) {
        var node = element.firstChild;
        while (node !== null) {
          if (node.nodeType === 3) {
            var value = node.nodeValue;
            if (value !== null && value !== undefined && value.replace(/\s+/g, '') !== '') return true;
          }
          node = node.nextSibling;
        }
        return false;
      }

      /** Whether this element (or an ancestor) already received a translation. */
      function alreadyTranslated(element) {
        if (element.hasAttribute(DONE_ATTR)) return true;
        var parent = element.parentElement;
        return parent !== null && parent.closest('[' + DONE_ATTR + ']') !== null;
      }

      /** Whether everything inside is laid out inline (one text run, not layout). */
      function inlineOnly(element) {
        var descendants = element.querySelectorAll('*');
        if (descendants.length > 60) return false;
        for (var d = 0; d < descendants.length; d += 1) {
          var style = window.getComputedStyle(descendants[d]);
          var display = style.display;
          if (display === 'none' || display === 'contents' || display === 'inline' || display === 'inline-block') continue;
          return false;
        }
        return true;
      }

      var mains = body.querySelectorAll('main, [role="main"]');
      var scopedToMain = mains.length > 0;
      var nodes = Array.prototype.slice.call(body.querySelectorAll(BLOCK_SELECTOR));
      var usable = [];
      for (var i = 0; i < nodes.length; i += 1) {
        if (scopedToMain && nodes[i].closest('main, [role="main"]') === null) continue;
        if (nodes[i].closest(SKIP_SELECTOR) !== null) continue;
        if (!safeDisplay(nodes[i])) continue;
        if (chromeRegion(nodes[i])) continue;
        usable.push(nodes[i]);
      }

      // An element that contains another block is only a container; the inner
      // block owns the text. This keeps one translation per visible paragraph.
      var containers = new Set();
      for (var j = 0; j < usable.length; j += 1) {
        var ancestor = usable[j].parentElement;
        while (ancestor !== null && ancestor !== body) {
          if (ancestor.matches(BLOCK_SELECTOR)) containers.add(ancestor);
          ancestor = ancestor.parentElement;
        }
      }

      var primed = [];
      var seen = new Set();
      for (var k = 0; k < usable.length; k += 1) {
        var element = usable[k];
        if (containers.has(element)) continue;
        if (alreadyTranslated(element)) continue;
        if (element.getAttribute(RUN_ATTR) === run && element.hasAttribute(MARK_ATTR)) continue;
        var text = textOf(element);
        if (text.length < 2 || text.length > 8000) continue;
        if (alreadyTarget(text)) continue;
        if (looksLikeIdentifier(text)) continue;
        // div/li are the ambiguous types: only treat one as a target when it
        // owns its text directly (a label or a paragraph), never when it is a
        // wrapper whose text comes from several links.
        var tag = element.tagName;
        if (tag === 'DIV' || tag === 'LI') {
          if (text.length > 400) continue;
          if (!hasDirectText(element)) continue;
        }
        primed.push({
          element: element,
          text: text,
          inView: inViewport(element),
          visible: !hidden(element),
          inline: /^H[1-6]$/.test(tag) || text.length <= 40,
        });
        seen.add(element);
      }

      // Inline labels inside a list row — an anchor or span that owns the whole
      // row text and has no block wrapper around it — are eligible too;
      // otherwise rows whose label is a bare inline element stay untranslated.
      var inlineLabels = Array.prototype.slice.call(body.querySelectorAll('a,span'));
      for (var n = 0; n < inlineLabels.length; n += 1) {
        var label = inlineLabels[n];
        if (seen.has(label)) continue;
        if (scopedToMain && label.closest('main, [role="main"]') === null) continue;
        if (label.closest(SKIP_SELECTOR) !== null) continue;
        if (chromeRegion(label)) continue;
        if (alreadyTranslated(label)) continue;
        var row = label.closest('li');
        if (row === null) continue;
        if (!hasDirectText(label)) continue;
        var labelStyle = window.getComputedStyle(label);
        if (labelStyle.display !== 'inline' && labelStyle.display !== 'inline-block') continue;
        var labelText = textOf(label);
        if (labelText.length < 2 || labelText.length > 200) continue;
        if (alreadyTarget(labelText)) continue;
        if (looksLikeIdentifier(labelText)) continue;
        if (hidden(label)) continue;
        if (textOf(row) !== labelText) continue;
        var blockedAncestor = false;
        var walk = label.parentElement;
        while (walk !== null && walk !== row) {
          if (walk.matches(BLOCK_SELECTOR)) {
            blockedAncestor = true;
            break;
          }
          walk = walk.parentElement;
        }
        if (blockedAncestor) continue;
        seen.add(label);
        primed.push({
          element: label,
          text: labelText,
          inView: inViewport(label),
          visible: true,
          inline: true,
        });
      }

      // Text runs that live in nested inline elements (spans or links inside a
      // custom-component app) are covered too: an element that only contains
      // inline content and at most one control owns one readable run.
      var extraNodes = Array.prototype.slice.call(body.querySelectorAll('a,article,section,div,span'));
      for (var q = 0; q < extraNodes.length; q += 1) {
        var extra = extraNodes[q];
        if (seen.has(extra)) continue;
        if (scopedToMain && extra.closest('main, [role="main"]') === null) continue;
        if (extra.closest(SKIP_SELECTOR) !== null) continue;
        if (chromeRegion(extra)) continue;
        if (alreadyTranslated(extra)) continue;
        var extraStyle = window.getComputedStyle(extra);
        var extraDisplay = extraStyle.display;
        if (extraDisplay === 'contents' || extraDisplay.indexOf('flex') !== -1 || extraDisplay.indexOf('grid') !== -1) continue;
        var extraText = textOf(extra);
        if (extraText.length < 4 || extraText.length > 400) continue;
        if (alreadyTarget(extraText)) continue;
        if (looksLikeIdentifier(extraText)) continue;
        if (hidden(extra)) continue;
        if (!hasDirectText(extra) && !inlineOnly(extra)) continue;
        var extraControls = extra.querySelectorAll('a,button,[role="button"]');
        if (extraControls.length > 1) continue;
        if (extra.tagName === 'A' && extraControls.length > 0) continue;
        // Skip only when an ancestor is already a chosen target; an ancestor
        // that was filtered out (flex row, skip list) must not swallow the run.
        var ancestorTarget = false;
        var up = extra.parentElement;
        for (var d = 0; d < 5 && up !== null; d += 1) {
          if (seen.has(up)) {
            ancestorTarget = true;
            break;
          }
          up = up.parentElement;
        }
        if (ancestorTarget) continue;
        seen.add(extra);
        primed.push({
          element: extra,
          text: extraText,
          inView: inViewport(extra),
          visible: true,
          inline: extraText.length <= 40,
        });
      }

      primed.sort(function (left, right) {
        var leftScore = (left.inView ? 2 : 0) + (left.visible ? 1 : 0);
        var rightScore = (right.inView ? 2 : 0) + (right.visible ? 1 : 0);
        return rightScore - leftScore;
      });

      var blocks = [];
      var used = 0;
      for (var m = 0; m < primed.length && blocks.length < maxBlocks; m += 1) {
        var candidate = primed[m];
        if (blocks.length > 0 && used + candidate.text.length > maxChars) break;
        var id = String(blocks.length);
        var hash = textHash(candidate.text);
        candidate.element.setAttribute(MARK_ATTR, id);
        candidate.element.setAttribute(HASH_ATTR, hash);
        candidate.element.setAttribute(RUN_ATTR, run);
        blocks.push({ id: id, text: candidate.text, hash: hash, run: run, inline: candidate.inline === true });
        used += candidate.text.length;
      }
      return {
        ok: true,
        blocks: blocks,
        total: primed.length,
        truncated: primed.length > blocks.length,
      };
    }
    // #endregion

    /** Pages that are mid-translation, keyed by their guest element. */
    const activeRuns = new Map();
    /** Views whose later-loaded content is translated periodically. */
    const liveLoops = new Map();
    /** Views currently running one incremental pass. */
    const backgroundViews = new Set();
    /** Source-text memory shared by every page of this Client session. */
    const memory = new Map();

    /** Resolve the UI language as the destination language. */
    function uiLanguage(ctx) {
      try {
        const snapshot = ctx.locale.getSnapshot();
        const active = snapshot !== null && typeof snapshot === 'object' ? snapshot.active : undefined;
        if (typeof active === 'string' && active !== '') return active;
      } catch (_error) {
        // Fall through to the shipped default.
      }
      return 'zh-CN';
    }

    /** Map a locale tag to the endpoint's language code. */
    function endpointLanguage(tag) {
      const lower = String(tag).toLowerCase();
      if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-sg' || lower === 'zh-hans') return 'zh-Hans';
      if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') return 'zh-Hant';
      return tag;
    }

    /** Translate one batch of source strings, preserving their order. */
    async function translateBatch(texts, targetLanguage, signal) {
      const url = ENDPOINT + '?to=' + encodeURIComponent(endpointLanguage(targetLanguage)) + '&isEnterpriseClient=false';
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(texts),
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('HTTP ' + String(response.status));
        const payload = await response.json();
        if (!Array.isArray(payload) || payload.length !== texts.length) throw new Error('invalid translation response');
        return payload.map((item) => {
          const translation = item !== null && typeof item === 'object' && Array.isArray(item.translations)
            ? item.translations[0]
            : undefined;
          return translation !== null && translation !== undefined && typeof translation.text === 'string' ? translation.text : '';
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }

    /** Read the preferred translation engine. */
    function readEnginePreference() {
      try {
        return window.localStorage.getItem(ENGINE_KEY) === 'bing' ? 'bing' : 'route';
      } catch (_error) {
        return 'route';
      }
    }

    /** Persist the preferred translation engine. */
    function writeEnginePreference(value) {
      enginePreference = value === 'bing' ? 'bing' : 'route';
      try {
        window.localStorage.setItem(ENGINE_KEY, enginePreference);
      } catch (_error) {
        // Storage can be unavailable; the choice then lasts for this run.
      }
    }

    /** Translate through the Host route (DeepSeek / Google / Bing chain). */
    async function translateViaRoute(texts, targetLanguage, signal) {
      if (texts.length === 0) return [];
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(TRANSLATE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts, to: targetLanguage, sessionId: activeSessionId }),
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const payload = await response.json();
        if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.translations)) return null;
        if (payload.translations.length !== texts.length) return null;
        const translated = texts.map((_, index) => (typeof payload.translations[index] === 'string' ? payload.translations[index] : ''));
        if (translated.every((text) => text === '')) return null;
        return translated;
      } catch (_error) {
        return null;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }

    /** Translate a batch with the selected engine, falling back to Bing. */
    async function translateTexts(texts, targetLanguage, signal) {
      if (texts.length === 0) return [];
      if (enginePreference !== 'bing') {
        const routed = await translateViaRoute(texts, targetLanguage, signal);
        if (routed !== null) return routed;
      }
      return translateBatch(texts, targetLanguage, signal);
    }

    /** Group blocks into endpoint-sized batches. */
    function buildBatches(blocks) {
      const batches = [];
      let current = [];
      let characters = 0;
      for (const block of blocks) {
        if (current.length > 0 && (current.length >= BATCH_TEXTS || characters + block.text.length > BATCH_CHARS)) {
          batches.push(current);
          current = [];
          characters = 0;
        }
        current.push(block);
        characters += block.text.length;
      }
      if (current.length > 0) batches.push(current);
      return batches;
    }

    /** Run `worker` over `items` with at most `concurrency` in flight. */
    async function runPool(items, worker, concurrency, signal) {
      let next = 0;
      const lanes = Math.max(1, Math.min(concurrency, items.length));
      const run = async () => {
        for (;;) {
          if (signal.aborted) return;
          const index = next;
          next += 1;
          if (index >= items.length) return;
          await worker(items[index], index);
        }
      };
      const running = [];
      for (let lane = 0; lane < lanes; lane += 1) running.push(run());
      await Promise.all(running);
    }

    /** Find the guest page that belongs to `tab` (or the visible one). */
    function findView(tab) {
      const candidates = Array.prototype.slice.call(document.querySelectorAll(VIEW_SELECTOR));
      if (candidates.length === 0) return null;
      const visible = candidates.filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 60) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      const title = tab !== undefined && tab !== null && typeof tab.title === 'string' ? tab.title : '';
      if (title !== '') {
        const matched = candidates.find((element) => {
          try {
            return element.getTitle() === title;
          } catch (_error) {
            return false;
          }
        });
        if (matched !== undefined) return matched;
      }
      if (visible.length > 0) {
        visible.sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
        });
        return visible[0];
      }
      return candidates.length === 1 ? candidates[0] : null;
    }

    /**
     * Execute page script. A guest that is mid-navigation rejects with an IPC
     * error ("GUEST_VIEW_MANAGER_CALL" / "Script failed to execute"); one short
     * retry turns that race into a normal result instead of a failure notice.
     */
    async function pageExec(view, source) {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await view.executeJavaScript(source);
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      throw lastError;
    }

    /** True when the error means the guest page was busy or navigated away. */
    function isGuestRace(error) {
      const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error);
      return /GUEST_VIEW_MANAGER_CALL|Script failed to execute|ERR_ABORTED|destroyed/i.test(message);
    }

    /** Translate one browser page, streaming results into the document. */
    async function translatePage(ctx, t, view, signal, depth) {
      const say = async (message) => {
        try {
          await pageExec(view, 'window.__dshPT && window.__dshPT.status(' + JSON.stringify(String(message)) + ')');
        } catch (_error) {
          // The page may have navigated away; the run will notice.
        }
      };
      const hideLater = () => {
        setTimeout(() => {
          if (signal.aborted) return;
          try {
            const pending = pageExec(view, 'window.__dshPT && window.__dshPT.hide()');
            if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
          } catch (_error) {
            // Page gone; nothing to hide.
          }
        }, NOTICE_MS);
      };

      await pageExec(view, '(function () { try { return (' + pageTranslateInstall.toString() + ')(); } catch (error) { return "error:" + String((error && error.message) || error); } })()').then((installed) => {
        if (typeof installed === 'string' && installed.indexOf('error:') === 0) {
          throw new Error('install failed: ' + installed.slice(6));
        }
      });
      await say(t('status.preparing'));

      // Every run stamps its marks with a run id and a source-text hash, so a
      // translation can only land on the element whose text it actually
      // translates, even if the site re-renders its list in between.
      const runId = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      await pageExec(view, 'window.__dshPT.begin(' + JSON.stringify(runId) + ')');

      const targetLanguage = uiLanguage(ctx);
      const collectExpression = '(function () { try { return (' + pageTranslateCollect.toString() + ')(' + JSON.stringify({
        target: targetLanguage,
        maxBlocks: MAX_BLOCKS,
        maxChars: MAX_CHARS,
        run: runId,
      }) + '); } catch (error) { return { ok: false, error: String((error && error.message) || error) }; } })()';
      const collected = await pageExec(view, collectExpression);
      if (signal.aborted) return;
      if (collected === null || typeof collected !== 'object' || collected.ok !== true) {
        const reason = collected !== null && typeof collected === 'object' && typeof collected.error === 'string'
          ? collected.error.slice(0, 120)
          : '';
        if (reason !== '' && !isGuestRace(reason)) {
          await say(t('status.failed', { reason }));
          hideLater();
          return;
        }
        await say(t('status.empty'));
        hideLater();
        return;
      }
      const blocks = Array.isArray(collected.blocks) ? collected.blocks : [];
      if (blocks.length === 0) {
        const attempt = depth === undefined ? 0 : depth;
        // A client-rendered page can finish loading before its content mounts;
        // give the document a moment and collect again instead of reporting an
        // empty page.
        if (attempt < 2 && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          if (signal.aborted) return;
          return translatePage(ctx, t, view, signal, attempt + 1);
        }
        await say(t('status.empty'));
        hideLater();
        return;
      }

      const total = blocks.length;
      let done = 0;
      let failed = 0;
      let appliedCount = 0;
      const pending = [];
      let timer = null;
      let flushing = null;

      const flush = async () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal.aborted) return;
        if (flushing !== null) await flushing;
        if (pending.length === 0) return;
        const batch = pending.splice(0, pending.length);
        flushing = (async () => {
          try {
            if (!signal.aborted) {
              const applied = await pageExec(view, 'window.__dshPT && window.__dshPT.apply(' + JSON.stringify(batch) + ')');
              if (typeof applied === 'number') appliedCount += applied;
            }
          } catch (_error) {
            // Page navigated; results are dropped with it.
          }
          await say(t('status.translating', { done: String(done), total: String(total) }));
        })();
        try {
          await flushing;
        } finally {
          flushing = null;
        }
      };

      const deliver = (block, text) => {
        done += 1;
        if (text !== '') pending.push({ id: block.id, text, hash: block.hash, run: runId, inline: block.inline === true });
        else failed += 1;
      };

      const translateOne = async (block) => {
        const key = targetLanguage + '\u0000' + block.text;
        const cached = memory.get(key);
        if (cached !== undefined) return { block, text: cached };
        let text = '';
        try {
          const quoted = await translateTexts([block.text], targetLanguage, signal);
          text = quoted[0];
        } catch (_error) {
          text = '';
        }
        if (text !== '') {
          if (memory.size >= CACHE_LIMIT) memory.delete(memory.keys().next().value);
          memory.set(key, text);
        }
        return { block, text };
      };

      const work = async (batch) => {
        if (signal.aborted) return;
        const missing = [];
        const ready = new Map();
        for (const block of batch) {
          const cached = memory.get(targetLanguage + '\u0000' + block.text);
          if (cached !== undefined) ready.set(block.id, cached);
          else missing.push(block);
        }
        for (const block of batch) {
          if (ready.has(block.id)) deliver(block, ready.get(block.id));
        }
        if (missing.length === 0) return;
        let results;
        try {
          results = await translateTexts(missing.map((block) => block.text), targetLanguage, signal);
        } catch (_error) {
          // One batch failed; retry its blocks one by one so a single bad
          // fragment cannot fail the whole batch.
          for (const block of missing) {
            if (signal.aborted) return;
            const single = await translateOne(block);
            deliver(single.block, single.text);
          }
          return;
        }
        if (signal.aborted) return;
        for (let index = 0; index < missing.length; index += 1) {
          const block = missing[index];
          const text = typeof results[index] === 'string' ? results[index] : '';
          if (text !== '') {
            const key = targetLanguage + '\u0000' + block.text;
            if (memory.size >= CACHE_LIMIT) memory.delete(memory.keys().next().value);
            memory.set(key, text);
          }
          deliver(block, text);
        }
      };

      const batches = buildBatches(blocks);
      const worker = async (batch) => {
        if (signal.aborted) return;
        await work(batch);
        if (signal.aborted) return;
        if (pending.length >= 8) await flush();
        else if (timer === null) timer = setTimeout(() => { void flush(); }, 150);
      };

      try {
        await say(t('status.translating', { done: '0', total: String(total) }));
        await runPool(batches, worker, CONCURRENCY, signal);
        await flush();
        if (signal.aborted) return;
        // A client-side re-render may have replaced most marked elements while
        // translating; re-collect once against the settled document.
        if ((depth === undefined ? 0 : depth) < 2 && appliedCount < total * 0.6) {
          return translatePage(ctx, t, view, signal, (depth === undefined ? 0 : depth) + 1);
        }
        if (failed === 0) await say(t('status.done', { count: String(done - failed) }));
        else await say(t('status.partial', { failed: String(failed), total: String(total) }));
        // Keep translating content the page adds later (infinite scroll, lazy
        // cards) until the user restores the original page.
        startLive(ctx, t, view);
      } finally {
        if (timer !== null) clearTimeout(timer);
        hideLater();
      }
    }

    /** Stop any running translation and remove inserted copy. */
    function restorePage(view) {
      stopLive(view);
      const controller = activeRuns.get(view);
      if (controller !== undefined) {
        controller.abort();
        activeRuns.delete(view);
      }
      try {
        const pending = pageExec(view, 'window.__dshPT ? window.__dshPT.clear() : undefined');
        if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (_error) {
        // Page gone; nothing to restore.
      }
    }

    /** Start one page translation, replacing any previous run on that view. */
    function startPage(ctx, t, view) {
      stopLive(view);
      const previous = activeRuns.get(view);
      if (previous !== undefined) previous.abort();
      const controller = new AbortController();
      activeRuns.set(view, controller);
      const settle = () => {
        if (activeRuns.get(view) === controller) activeRuns.delete(view);
      };
      translatePage(ctx, t, view, controller.signal)
        .catch(async (error) => {
          if (controller.signal.aborted) return;
          const raw = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : '';
          let message;
          if (raw === '') {
            message = t('status.failed', { reason: 'unknown' });
          } else if (isGuestRace(error)) {
            // The guest was navigating; the page is fine, just retry.
            message = t('status.busy');
          } else {
            message = t('status.failed', { reason: raw.slice(0, 140) });
          }
          try {
            await pageExec(view, 'window.__dshPT && window.__dshPT.status(' + JSON.stringify(message) + ')');
          } catch (_error) {
            // Page gone.
          }
        })
        .finally(settle);
    }

    /** Stop the incremental translation loop of one view. */
    function stopLive(view) {
      const state = liveLoops.get(view);
      if (state === undefined) return;
      window.clearInterval(state.timer);
      liveLoops.delete(view);
    }

    /** Translate content that appeared after the initial pass, once per second. */
    function startLive(ctx, t, view) {
      if (liveLoops.has(view)) return;
      const state = { timer: null };
      liveLoops.set(view, state);
      state.timer = window.setInterval(() => {
        if (!liveLoops.has(view)) return;
        if (activeRuns.has(view) || backgroundViews.has(view)) return;
        let probe;
        try {
          probe = pageExec(view, 'window.__dshPT && typeof window.__dshPT.dirty === "function" ? window.__dshPT.dirty() : false');
        } catch (_error) {
          stopLive(view);
          return;
        }
        probe.then((dirty) => {
          if (dirty !== true || !liveLoops.has(view)) return;
          if (activeRuns.has(view) || backgroundViews.has(view)) return;
          void translateIncremental(ctx, t, view);
        }).catch(() => {});
      }, 1200);
    }

    /** One incremental pass over whatever the page added since the last pass. */
    async function translateIncremental(ctx, t, view) {
      if (backgroundViews.has(view)) return;
      backgroundViews.add(view);
      try {
        const runId = 'l' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        await pageExec(view, 'window.__dshPT.begin(' + JSON.stringify(runId) + ')');
        if (!liveLoops.has(view) || activeRuns.has(view)) return;
        const targetLanguage = uiLanguage(ctx);
        const expression = '(function () { try { return (' + pageTranslateCollect.toString() + ')(' + JSON.stringify({
          target: targetLanguage,
          maxBlocks: 80,
          maxChars: 20000,
          run: runId,
        }) + '); } catch (error) { return { ok: false }; } })()';
        const collected = await pageExec(view, expression);
        if (!liveLoops.has(view) || activeRuns.has(view)) return;
        const blocks = collected !== null && typeof collected === 'object' && collected.ok === true && Array.isArray(collected.blocks)
          ? collected.blocks
          : [];
        if (blocks.length === 0) return;
        for (const batch of buildBatches(blocks)) {
          if (!liveLoops.has(view)) return;
          const items = [];
          const missing = [];
          for (const block of batch) {
            const key = targetLanguage + '\u0000' + block.text;
            const cached = memory.get(key);
            if (cached !== undefined) items.push({ id: block.id, text: cached, hash: block.hash, run: runId, inline: block.inline === true });
            else missing.push(block);
          }
          if (missing.length > 0) {
            try {
              const translated = await translateTexts(missing.map((block) => block.text), targetLanguage, new AbortController().signal);
              for (let index = 0; index < missing.length; index += 1) {
                const text = typeof translated[index] === 'string' ? translated[index] : '';
                if (text === '') continue;
                const key = targetLanguage + '\u0000' + missing[index].text;
                if (memory.size >= CACHE_LIMIT) memory.delete(memory.keys().next().value);
                memory.set(key, text);
                items.push({ id: missing[index].id, text, hash: missing[index].hash, run: runId, inline: missing[index].inline === true });
              }
            } catch (_error) {
              // Leave this batch for a later pass.
            }
          }
          if (items.length > 0) {
            await pageExec(view, 'window.__dshPT && window.__dshPT.apply(' + JSON.stringify(items) + ')');
          }
        }
      } catch (_error) {
        // Background failures are retried by the next dirty check.
      } finally {
        backgroundViews.delete(view);
      }
    }

    /** Read the current page's inserted-translation count. */
    async function translationCount(view) {
      try {
        const count = await pageExec(view, 'window.__dshPT ? window.__dshPT.count() : document.querySelectorAll("[data-dsh-pt-trans]").length');
        return typeof count === 'number' ? count : 0;
      } catch (_error) {
        return 0;
      }
    }

    /** Read the per-origin auto-translate preferences. */
    function readAutoSites() {
      try {
        const raw = window.localStorage.getItem(AUTO_KEY);
        const parsed = raw === null ? null : JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch (_error) {
        return {};
      }
    }

    /** Persist the per-origin auto-translate preferences. */
    function writeAutoSites(map) {
      try {
        window.localStorage.setItem(AUTO_KEY, JSON.stringify(map));
      } catch (_error) {
        // Storage can be unavailable; automatic translation then stays off.
      }
    }

    /** The http(s) origin of a Browser guest, or null. */
    function originOf(view) {
      try {
        const url = view.getURL();
        if (typeof url !== 'string' || url.indexOf('http') !== 0) return null;
        return new URL(url).origin;
      } catch (_error) {
        return null;
      }
    }

    /** Whether this guest's site is marked for automatic translation. */
    function isAutoSite(view) {
      const origin = originOf(view);
      return origin !== null && readAutoSites()[origin] === true;
    }

    /** Mark or unmark this guest's site for automatic translation. */
    function setAutoSite(view, enabled) {
      const origin = originOf(view);
      if (origin === null) return false;
      const map = readAutoSites();
      if (enabled) map[origin] = true;
      else delete map[origin];
      writeAutoSites(map);
      return enabled;
    }

    /** Guests whose reload events are already observed. */
    const listeningViews = new WeakSet();

    /** Read a small readiness signal from the guest page. */
    async function pageReadyState(view) {
      try {
        const signal = await pageExec(view, '(function () { var main = document.querySelector(\'main,[role="main"]\'); var scope = main || document.body; var length = scope ? scope.innerText.length : 0; return [document.readyState, length, main ? 1 : 0].join("|"); })()');
        if (typeof signal !== 'string') return { ready: false };
        const parts = signal.split('|');
        return { ready: parts[0] === 'complete' && Number(parts[1]) > 60 };
      } catch (_error) {
        return { ready: false };
      }
    }

    /** Retry an automatic translation until the page has actually rendered. */
    function attemptAutoTranslation(ctx, t, view, expectedUrl, attempt) {
      if (activeRuns.has(view)) return;
      if (!isAutoSite(view)) return;
      let current = null;
      try {
        current = view.getURL();
      } catch (_error) {
        current = null;
      }
      if (current !== expectedUrl) return;
      let loading = false;
      try {
        loading = typeof view.isLoading === 'function' ? view.isLoading() : false;
      } catch (_error) {
        loading = false;
      }
      pageReadyState(view).then((state) => {
        if (activeRuns.has(view)) return;
        if (!isAutoSite(view)) return;
        const settled = !loading && state.ready;
        if (!settled) {
          if (attempt < 15) setTimeout(() => attemptAutoTranslation(ctx, t, view, expectedUrl, attempt + 1), 800);
          return;
        }
        translationCount(view).then((count) => {
          if (count > 0) return;
          let now = null;
          try {
            now = view.getURL();
          } catch (_error) {
            now = null;
          }
          if (now !== expectedUrl) return;
          startPage(ctx, t, view);
        }).catch(() => {});
      }).catch(() => {});
    }

    /** Translate every newly loaded page of a site marked automatic. */
    function ensureAutoListeners(ctx, t) {
      const views = document.querySelectorAll(VIEW_SELECTOR);
      for (const view of views) {
        if (listeningViews.has(view)) continue;
        listeningViews.add(view);
        let queued = null;
        const schedule = () => {
          if (queued !== null) clearTimeout(queued);
          queued = setTimeout(() => {
            queued = null;
            let url = null;
            try {
              url = view.getURL();
            } catch (_error) {
              url = null;
            }
            if (typeof url !== 'string') return;
            attemptAutoTranslation(ctx, t, view, url, 0);
          }, AUTO_DELAY_MS);
        };
        view.addEventListener('dom-ready', schedule);
        view.addEventListener('did-finish-load', schedule);
        view.addEventListener('did-navigate', schedule);
        view.addEventListener('did-navigate-in-page', schedule);
        // A guest that already finished loading before this listener attached
        // still joins the site preference.
        if (isAutoSite(view)) schedule();
      }
    }

    /** Shared translate/restore toggle for both entry points. */
    async function togglePage(ctx, t, view) {
      const count = await translationCount(view);
      if (count > 0) {
        restorePage(view);
        return;
      }
      // A manual translation also makes this site translate on later pages.
      setAutoSite(view, true);
      startPage(ctx, t, view);
    }

    /** The tab-menu row; rendered for Browser tabs only. */
    function createMenuItem(ctx, t) {
      return function PageTranslateMenuItem(props) {
        const tab = props !== null && typeof props === 'object' ? props.tab : undefined;
        const isBrowser = tab !== undefined && tab !== null && tab.kind === BROWSER_KIND;
        const translate = typeof props.t === 'function' ? props.t : t;
        const [phase, setPhase] = React.useState('checking');
        const viewRef = React.useRef(null);

        React.useEffect(() => {
          if (!isBrowser) return undefined;
          let cancelled = false;
          const view = findView(tab);
          viewRef.current = view;
          if (view === null || typeof view.executeJavaScript !== 'function') {
            setPhase('unavailable');
            return () => {
              cancelled = true;
            };
          }
          translationCount(view).then((count) => {
            if (!cancelled) setPhase(count > 0 ? 'translated' : 'ready');
          });
          return () => {
            cancelled = true;
          };
        }, [isBrowser, tab === undefined ? '' : tab.id]);

        if (!isBrowser) return null;

        const label = phase === 'translated'
          ? translate('menu.restore')
          : phase === 'unavailable'
            ? translate('menu.unavailable')
            : translate('menu.translate');
        const accessible = phase === 'translated' ? translate('a11y.restore') : translate('a11y.translate');
        const disabled = phase === 'checking' || phase === 'unavailable';

        const onClick = () => {
          if (typeof props.dismiss === 'function') props.dismiss();
          const view = viewRef.current;
          if (view === null) return;
          void togglePage(ctx, t, view);
        };

        return h(
          React.Fragment,
          null,
          h('style', { key: 'page-translate-menu-style', 'data-page-translate-style': true }, MENU_CSS),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'pt-menu-item',
              'aria-label': accessible,
              title: accessible,
              disabled,
              onClick,
            },
            translateGlyph('pt-icon'),
            h('span', { key: 'label' }, label),
          ),
        );
      };
    }

    /** The auto-translate toggle row in the tab menu. */
    function createAutoMenuItem(ctx, t) {
      return function PageTranslateAutoMenuItem(props) {
        const tab = props !== null && typeof props === 'object' ? props.tab : undefined;
        const isBrowser = tab !== undefined && tab !== null && tab.kind === BROWSER_KIND;
        const translate = typeof props.t === 'function' ? props.t : t;
        const [enabled, setEnabled] = React.useState(false);
        const [available, setAvailable] = React.useState(true);
        const viewRef = React.useRef(null);

        React.useEffect(() => {
          if (!isBrowser) return;
          if (typeof props.sessionId === 'string' && props.sessionId !== '') activeSessionId = props.sessionId;
          const view = findView(tab);
          viewRef.current = view;
          if (view === null || typeof view.executeJavaScript !== 'function') {
            setAvailable(false);
            return;
          }
          setAvailable(true);
          setEnabled(isAutoSite(view));
        }, [isBrowser, tab === undefined ? '' : tab.id]);

        if (!isBrowser) return null;

        const label = enabled ? translate('auto.on') : translate('auto.off');
        const onClick = () => {
          if (typeof props.dismiss === 'function') props.dismiss();
          const view = viewRef.current;
          if (view === null) return;
          const next = !isAutoSite(view);
          setAutoSite(view, next);
          setEnabled(next);
          if (next) {
            void translationCount(view).then((count) => {
              if (count === 0) startPage(ctx, t, view);
            }).catch(() => {});
          }
        };

        return h(
          React.Fragment,
          null,
          h('style', { key: 'page-translate-menu-style', 'data-page-translate-style': true }, MENU_CSS),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'pt-menu-item',
              'aria-label': translate('auto.a11y'),
              title: translate('auto.a11y'),
              disabled: !available,
              onClick,
            },
            translateGlyph('pt-icon'),
            h('span', { key: 'label' }, label),
          ),
        );
      };
    }

    /** The engine-selection row in the tab menu. */
    function createEngineMenuItem(ctx, t) {
      return function PageTranslateEngineMenuItem(props) {
        const tab = props !== null && typeof props === 'object' ? props.tab : undefined;
        const isBrowser = tab !== undefined && tab !== null && tab.kind === BROWSER_KIND;
        const translate = typeof props.t === 'function' ? props.t : t;
        const [engine, setEngine] = React.useState(readEnginePreference());
        if (props !== null && typeof props === 'object' && typeof props.sessionId === 'string' && props.sessionId !== '') {
          activeSessionId = props.sessionId;
        }
        if (!isBrowser) return null;
        const label = engine === 'route' ? translate('engine.route') : translate('engine.bing');
        const onClick = () => {
          if (typeof props.dismiss === 'function') props.dismiss();
          const next = readEnginePreference() === 'route' ? 'bing' : 'route';
          writeEnginePreference(next);
          setEngine(next);
        };
        return h(
          React.Fragment,
          null,
          h('style', { key: 'page-translate-engine-style', 'data-page-translate-style': true }, MENU_CSS),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'pt-menu-item',
              'aria-label': translate('engine.a11y'),
              title: translate('engine.a11y'),
              onClick,
            },
            translateGlyph('pt-icon'),
            h('span', { key: 'label' }, label),
          ),
        );
      };
    }

    /** Inline glyph shared by the menu row and the launcher. */
    function translateGlyph(className) {
      return h(
        'svg',
        {
          key: 'glyph',
          className: className,
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 8, cy: 8, r: 5.7 }),
        h('path', { d: 'M2.3 8h11.4' }),
        h('path', { d: 'M8 2.3c1.9 1.9 2.9 4.1 2.9 5.7S9.9 13.7 8 13.7C6.1 13.7 5.1 9.6 5.1 8S6.1 4.2 8 2.3' }),
      );
    }

    /**
     * Find the leftmost shipped control in the panel's top-right chrome strip.
     * The strip holds split, fullscreen and collapse buttons; the launcher is
     * inserted as a new sibling before that leftmost button, so none of them is
     * covered and the row's own gap and spacing apply.
     */
    function findChromeAnchor(panel) {
      const panelRect = panel.getBoundingClientRect();
      const candidates = [];
      let topMost = Infinity;
      const buttons = panel.querySelectorAll('button');
      for (const button of buttons) {
        if (button.closest('[' + LAUNCHER_MOUNT_ATTR + ']') !== null) continue;
        const rect = button.getBoundingClientRect();
        if (rect.width < 16 || rect.height < 16 || rect.width > 44 || rect.height > 44) continue;
        if (rect.left < panelRect.left + panelRect.width * 0.5) continue;
        candidates.push({ button: button, rect: rect });
        if (rect.top < topMost) topMost = rect.top;
      }
      let anchor = null;
      let anchorLeft = Infinity;
      for (const candidate of candidates) {
        if (Math.abs(candidate.rect.top - topMost) > 8) continue;
        if (candidate.rect.left < anchorLeft) {
          anchorLeft = candidate.rect.left;
          anchor = candidate.button;
        }
      }
      return anchor;
    }

    /**
     * Launcher in the panel chrome strip. A React portal mounts the button as a
     * real fourth control inside the strip row, so it shares the row's layout,
     * theme tokens and stacking (including the fullscreen presentation). A
     * MutationObserver re-inserts it when the panel re-renders.
     */
    function createLauncher(ctx, t) {
      function LauncherButton() {
        const [busy, setBusy] = React.useState(false);
        const onClick = () => {
          if (busy) return;
          const view = findView(null);
          if (view === null) return;
          setBusy(true);
          Promise.resolve()
            .then(() => togglePage(ctx, t, view))
            .catch(() => {})
            .finally(() => setBusy(false));
        };
        return h('button', {
          type: 'button',
          className: 'pt-launcher',
          'data-page-translate-launcher': true,
          'data-busy': busy ? 'true' : 'false',
          title: t('launcher.translate') + ' / ' + t('launcher.restore'),
          'aria-label': t('launcher.translate'),
          onClick,
        }, translateGlyph('pt-launcher-glyph'));
      }

      return function PageTranslateLauncher() {
        const [mounts, setMounts] = React.useState([]);

        React.useEffect(() => {
          let disposed = false;
          let raf = null;
          let interval = null;
          let lastSync = 0;
          const registry = new Map();

          const sync = () => {
            if (disposed) return;
            const wanted = [];
            const panels = document.querySelectorAll(PANEL_SELECTOR);
            for (const panel of panels) {
              const opened = panel.hasAttribute('data-sidebar-right-open')
                || panel.getAttribute('data-sidebar-right-panel') === 'fullscreen';
              if (!opened) continue;
              const rect = panel.getBoundingClientRect();
              if (rect.width < 200 || rect.height < 120) continue;
              const anchor = findChromeAnchor(panel);
              if (anchor === null || anchor.parentElement === null) continue;
              wanted.push({ host: anchor.parentElement, anchor: anchor });
            }
            const next = new Map();
            for (const item of wanted) {
              let kept = null;
              for (const entry of registry.values()) {
                if (entry.host === item.host && entry.anchor === item.anchor && entry.node.isConnected) {
                  kept = entry;
                  break;
                }
              }
              if (kept === null) {
                for (const entry of [...registry.values()]) {
                  if (entry.host !== item.host) continue;
                  entry.node.remove();
                  registry.delete(entry.node);
                }
                const node = document.createElement('div');
                node.setAttribute(LAUNCHER_MOUNT_ATTR, '1');
                node.style.display = 'contents';
                item.host.insertBefore(node, item.anchor);
                kept = { node: node, host: item.host, anchor: item.anchor };
              }
              next.set(kept.node, kept);
            }
            for (const entry of [...registry.values()]) {
              if (next.has(entry.node)) continue;
              entry.node.remove();
              registry.delete(entry.node);
            }
            for (const entry of next.values()) registry.set(entry.node, entry);
            const list = [...next.values()].map((entry) => entry.node);
            setMounts((previous) => (
              previous.length === list.length && previous.every((node, index) => node === list[index])
                ? previous
                : list
            ));
          };

          const schedule = () => {
            if (raf !== null) return;
            raf = requestAnimationFrame(() => {
              raf = null;
              const now = Date.now();
              if (now - lastSync < 350) return;
              lastSync = now;
              sync();
            });
          };

          sync();
          lastSync = Date.now();
          const observer = new MutationObserver(schedule);
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-sidebar-right-open', 'data-sidebar-right-panel'],
          });
          interval = setInterval(schedule, 1200);
          return () => {
            disposed = true;
            observer.disconnect();
            clearInterval(interval);
            if (raf !== null) cancelAnimationFrame(raf);
            for (const entry of registry.values()) entry.node.remove();
            registry.clear();
          };
        }, []);

        return h(
          React.Fragment,
          null,
          h('style', { key: 'page-translate-launcher-style', 'data-page-translate-launcher-style': true }, LAUNCHER_CSS),
          mounts.map((node, index) => ReactDOM.createPortal(
            h(LauncherButton, { key: 'launcher-' + String(index) }),
            node,
          )),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],

      /**
       * Mount the tab-menu action and the chrome launcher.
       * @param {object} ctx - Client plugin context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS);
        ctx.effect(() => () => {
          for (const controller of activeRuns.values()) controller.abort();
          activeRuns.clear();
          for (const state of liveLoops.values()) window.clearInterval(state.timer);
          liveLoops.clear();
          backgroundViews.clear();
        }, 'page-translate: cancel page runs');
        ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
          name: 'sidebar.right.tab.menu.item',
          id: 'page-translate',
          order: 60,
          locale: NS,
        }, createMenuItem(ctx, t)));
        ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
          name: 'sidebar.right.tab.menu.item',
          id: 'page-translate-auto',
          order: 61,
          locale: NS,
        }, createAutoMenuItem(ctx, t)));
        ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
          name: 'sidebar.right.tab.menu.item',
          id: 'page-translate-engine',
          order: 62,
          locale: NS,
        }, createEngineMenuItem(ctx, t)));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'page-translate-launcher',
          order: 40,
          locale: NS,
        }, createLauncher(ctx, t)));
        ctx.effect(() => {
          const timer = window.setInterval(() => ensureAutoListeners(ctx, t), 1500);
          ensureAutoListeners(ctx, t);
          return () => window.clearInterval(timer);
        }, 'page-translate: automatic translation listeners');
      },
    };
  },
});
