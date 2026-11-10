/*! papercuts widget | MIT | https://github.com/Tim-Conrad/papercuts */
// Load it early in <head>, so that it sees console errors from the start:
// <script src="https://papercuts.lab.t7d.dev/papercuts.js" data-repo="owner/name"></script>
(() => {
  if (window.papercuts) return;
  const script = document.currentScript;
  if (!script || !script.src) return;
  const relay = new URL(script.src).origin;
  const cfg = script.dataset;
  const QUEUE_DB = 'papercuts-queue-v1';
  const MAX_ERRORS = 20;
  const errors = [];

  const remember = (text) => {
    errors.push(String(text).slice(0, 500));
    if (errors.length > MAX_ERRORS) errors.shift();
  };
  addEventListener('error', (e) => remember(`${e.message} (${e.filename || ''}:${e.lineno || ''})`));
  addEventListener('unhandledrejection', (e) => remember(`unhandled rejection: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));
  const origError = console.error;
  console.error = function (...args) {
    try { remember(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); } catch (_) { /* keep console.error working */ }
    return origError.apply(this, args);
  };

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

  // ---- context ----
  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      let part = node.localName + [...node.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function dataAttrs(el) {
    const out = {};
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
      for (const a of node.attributes) if (a.name.startsWith('data-') && !(a.name in out)) out[a.name] = a.value.slice(0, 120);
    }
    return out;
  }

  function elementContext(el) {
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    return {
      path: cssPath(el),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      data: dataAttrs(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  function storageSubset() {
    const keys = (cfg.storage || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (!keys.length) return undefined;
    const out = {};
    for (const k of keys) {
      try { const v = localStorage.getItem(k); if (v !== null) out[k] = v.slice(0, 300); } catch (_) { /* storage blocked */ }
    }
    return out;
  }

  function autoContext(el) {
    let site;
    try { site = typeof window.papercutsContext === 'function' ? window.papercutsContext() : undefined; } catch (e) { site = { error: String(e) }; }
    const sel = String(getSelection()).trim().slice(0, 300);
    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      userAgent: navigator.userAgent,
      commit: cfg.commit || undefined,
      branch: cfg.branch || undefined,
      selection: sel || undefined,
      element: elementContext(el),
      errors: errors.length ? errors.slice() : undefined,
      storage: storageSubset(),
      site,
    };
  }

  // ---- queue (IndexedDB) ----
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(QUEUE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('reports', { keyPath: 'report.id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function queueOp(mode, fn) {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const tx = d.transaction('reports', mode);
        const req = fn(tx.objectStore('reports'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {
      return mode === 'readonly' ? [] : undefined;
    }
  }
  const enqueue = (payload) => queueOp('readwrite', (s) => s.put(payload));
  const dequeue = (id) => queueOp('readwrite', (s) => s.delete(id));
  const queued = () => queueOp('readonly', (s) => s.getAll());

  // ---- transport ----
  // A simple request: POST, text/plain, no custom headers. No preflight, so a login proxy can stay in front.
  async function send(payload) {
    let res;
    try {
      res = await fetch(`${relay}/report`, {
        method: 'POST', credentials: 'include', redirect: 'manual',
        headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload),
      });
    } catch (_) {
      return { delivered: false, transient: true, reason: 'offline' };
    }
    if (res.type === 'opaqueredirect' || res.redirected || (res.status >= 300 && res.status < 400)) {
      return { delivered: false, transient: true, reason: 'login' };
    }
    let data;
    try { data = await res.json(); } catch (_) { return { delivered: false, transient: true, reason: 'offline' }; }
    if (res.status >= 500) return { delivered: false, transient: true, reason: 'github', data };
    if (!res.ok) return { delivered: false, transient: false, data };
    return { delivered: true, data };
  }

  const REASON = {
    offline: { error: 'the relay does not answer', help: 'the report waits in this browser and goes out later' },
    login: { error: 'the login expired', help: 'log in again, then the report goes out' },
    github: { error: 'GitHub did not take the report', help: 'the report waits in this browser and goes out later' },
  };

  let ui = { badge() {}, notice() {}, open() {} };
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const payload of await queued()) {
        const r = await send(payload);
        if (r.delivered || !r.transient) {
          await dequeue(payload.report.id);
        } else {
          if (r.reason === 'login') ui.notice('Log in again, then the report goes out.');
          break;
        }
      }
    } finally {
      flushing = false;
      ui.badge();
    }
  }

  async function report(input = {}, el) {
    const payload = {
      from: input.from === 'human' ? 'human' : 'agent',
      report: {
        id: input.id || newId(),
        kind: input.kind,
        text: input.text,
        where: input.where,
        repo: input.repo || cfg.repo,
        context: Object.assign(autoContext(el), input.context || {}),
      },
    };
    const r = await send(payload);
    if (r.delivered) return r.data;
    if (!r.transient) return Object.assign({ ok: false, queued: false }, r.data);
    await enqueue(payload);
    ui.badge();
    return Object.assign({ ok: false, queued: true }, REASON[r.reason]);
  }

  async function status() {
    let reachable = false;
    try {
      const res = await fetch(`${relay}/status`, { credentials: 'include', redirect: 'manual' });
      reachable = res.ok && (await res.json()).ok === true;
    } catch (_) { reachable = false; }
    return { reachable, queued: (await queued()).length };
  }

  // ---- UI ----
  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; }
    .tab { position: fixed; right: 0; top: 50%; transform: translateY(-50%) rotate(180deg); writing-mode: vertical-rl;
      background: #111; color: #fff; border: 0; border-radius: 0 6px 6px 0; padding: 12px 6px; cursor: pointer; z-index: 2147483646; }
    .tab .count { color: #fff; }
    .panel { position: fixed; right: 8px; bottom: 8px; width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: auto;
      background: #fff; border: 1px solid #111; border-radius: 8px; padding: 12px; z-index: 2147483647; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
    [hidden] { display: none !important; }
    h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    button { border: 1px solid #111; background: #fff; border-radius: 4px; padding: 6px 10px; cursor: pointer; }
    button.send { background: #111; color: #fff; }
    button:disabled { opacity: .5; cursor: default; }
    .target { font: 12px/1.4 ui-monospace, monospace; color: #444; word-break: break-all; }
    select, textarea { width: 100%; border: 1px solid #888; border-radius: 4px; padding: 6px; background: #fff; }
    textarea { min-height: 80px; resize: vertical; margin-top: 6px; }
    .counter { font-size: 12px; color: #666; text-align: right; }
    .status { min-height: 1.4em; font-size: 13px; }
    .status a { color: #111; }
    .box { position: fixed; pointer-events: none; border: 2px solid #d00; background: rgba(221,0,0,.08); z-index: 2147483645; }
    .hint { position: fixed; left: 50%; top: 8px; transform: translateX(-50%); background: #111; color: #fff; padding: 6px 10px;
      border-radius: 4px; z-index: 2147483647; }
    @media (prefers-color-scheme: dark) {
      * { color: #eee; }
      .panel, button, select, textarea { background: #1a1a1a; border-color: #ccc; }
      button.send, .tab, .hint { background: #eee; color: #111; }
      .tab .count { color: #111; }
      .target, .counter { color: #aaa; }
      .status a { color: #eee; }
    }`;

  function createUi() {
    const els = {};
    let picked = null;
    let picking = false;
    let host;

    function h(tag, props = {}, ...kids) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
      el.append(...kids);
      return el;
    }

    function showBox(el) {
      if (!el) { els.box.hidden = true; return; }
      const r = el.getBoundingClientRect();
      // CSSOM properties, not a style attribute: a strict CSP allows this.
      Object.assign(els.box.style, { left: `${r.x - 2}px`, top: `${r.y - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      els.box.hidden = false;
    }

    function setTarget(el) {
      picked = el;
      els.target.textContent = el ? cssPath(el) : 'Whole view';
      els.parent.disabled = !el || !el.parentElement || el.parentElement === document.documentElement;
      showBox(el);
    }

    const pointAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el !== host ? el : null;
    };
    const onMove = (e) => { const el = pointAt(e); if (el) showBox(el); };
    const onPick = (e) => {
      const el = pointAt(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      stopPicking();
      setTarget(el);
    };
    const swallow = (e) => { if (e.target !== host) { e.preventDefault(); e.stopPropagation(); } };
    const onKey = (e) => { if (e.key === 'Escape') { stopPicking(); setTarget(picked); } };
    const PICK_EVENTS = [['pointermove', onMove], ['click', onPick], ['pointerdown', swallow], ['mousedown', swallow], ['keydown', onKey]];

    function startPicking() {
      picking = true;
      els.panel.hidden = true;
      els.hint.hidden = false;
      for (const [type, fn] of PICK_EVENTS) addEventListener(type, fn, true);
    }
    function stopPicking() {
      if (!picking) return;
      picking = false;
      els.panel.hidden = false;
      els.hint.hidden = true;
      for (const [type, fn] of PICK_EVENTS) removeEventListener(type, fn, true);
    }

    function open() {
      els.panel.hidden = false;
      setTarget(picked);
      els.text.focus();
    }
    function close() {
      stopPicking();
      els.panel.hidden = true;
      els.box.hidden = true;
    }
    const toggle = () => (els.panel.hidden ? open() : close());

    async function submit() {
      const text = els.text.value.trim();
      if (!text) { els.status.textContent = 'Write one sentence first.'; return; }
      els.send.disabled = true;
      els.status.textContent = 'Sending…';
      const r = await window.papercuts.report({ kind: els.kind.value, text, from: 'human', _el: picked });
      els.send.disabled = false;
      els.status.textContent = '';
      if (r.ok) {
        els.status.append('Sent: ', h('a', { href: r.url, target: '_blank', rel: 'noopener' }, `#${r.issue}`));
        els.text.value = '';
        els.counter.textContent = '0 / 300';
      } else if (r.queued) {
        els.status.textContent = `Saved in this browser: ${r.error}. ${r.help}.`;
      } else {
        els.status.textContent = `Not sent: ${r.error}. ${r.help || ''}`;
      }
    }

    host = document.createElement('papercuts-widget');
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      // A constructed sheet needs no <style> element, so the host page CSP does not block it.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      shadow.append(h('style', {}, CSS_TEXT));
    }
    els.count = h('span', { class: 'count' });
    els.tab = h('button', { class: 'tab', type: 'button', title: 'Report a papercut (Alt+Shift+P)', onclick: toggle }, 'Papercut', els.count);
    els.target = h('div', { class: 'target' });
    els.parent = h('button', { type: 'button', class: 'parent', onclick: () => picked && setTarget(picked.parentElement) }, 'Parent');
    els.kind = h('select', { 'aria-label': 'Kind' }, ...['bug', 'ux', 'copy', 'other'].map((k) => h('option', { value: k }, k)));
    els.text = h('textarea', { maxlength: '300', placeholder: 'One sentence: what is wrong?', 'aria-label': 'Papercut' });
    els.counter = h('div', { class: 'counter' }, '0 / 300');
    els.text.addEventListener('input', () => { els.counter.textContent = `${els.text.value.length} / 300`; });
    els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    els.send = h('button', { type: 'button', class: 'send', onclick: submit }, 'Send');
    els.status = h('div', { class: 'status', role: 'status' });
    els.panel = h('div', { class: 'panel', hidden: '' },
      h('h2', {}, 'Papercut'),
      els.target,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'pick', onclick: startPicking }, 'Pick'),
        els.parent,
        h('button', { type: 'button', class: 'whole', onclick: () => setTarget(null) }, 'Whole view')),
      els.kind, els.text, els.counter,
      h('div', { class: 'row' }, els.send, h('button', { type: 'button', class: 'close', onclick: close }, 'Close')),
      els.status);
    els.box = h('div', { class: 'box', hidden: '' });
    els.hint = h('div', { class: 'hint', hidden: '' }, 'Tap the part you mean. Esc cancels.');
    shadow.append(els.box, els.hint, els.tab, els.panel);
    document.documentElement.append(host);
    setTarget(null);
    els.box.hidden = true;
    addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyP') { e.preventDefault(); toggle(); }
    });

    return {
      open,
      async badge() {
        const n = (await queued()).length;
        els.count.textContent = n ? ` · ${n} waiting` : '';
      },
      notice(text) { els.status.textContent = text; },
    };
  }

  window.papercuts = {
    // `_el` is internal: the widget passes the picked element. Agents leave it out.
    report: (input = {}) => {
      const { _el, ...rest } = input;
      return report(rest, _el).catch((e) => ({ ok: false, error: String((e && e.message) || e), help: 'read the browser console' }));
    },
    status,
    flush,
    open: () => ui.open(),
  };

  async function start() {
    const s = await status();
    if (!s.reachable) return;
    ui = createUi();
    ui.badge();
    flush();
  }
  addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
  setInterval(flush, 60000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
