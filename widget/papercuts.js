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
  const POS_KEY = 'papercuts-pos-v1';
  const SEEN_KEY = 'papercuts-seen-v1';
  const MAX_ERRORS = 20;
  const KINDS = ['bug', 'ux', 'copy', 'idea', 'other'];
  // ?papercuts=download or data-mode="download": no relay, the report becomes a file for `papercuts import`.
  const DOWNLOAD = new URLSearchParams(location.search).get('papercuts') === 'download' || cfg.mode === 'download';
  const errors = [];

  // All words of the widget. The JS API answers in English for agents.
  const T = {
    en: {
      tab: 'Papercut', tabTitle: 'Report a papercut (Alt+Shift+P)', title: 'Papercut', pick: 'Pick', parent: 'Parent',
      whole: 'Whole view', kind: 'Kind', placeholder: 'One sentence: what is wrong?', send: 'Send', download: 'Download report',
      close: 'Close', sending: 'Sending…', sent: 'Sent: ', writeFirst: 'Write one sentence first.',
      saved: 'Saved in this browser. It goes out later.', savedLogin: 'Saved in this browser. Log in again, then it goes out.',
      notSent: 'Not sent: ', hint: 'Tap the part you mean. Esc cancels.', waiting: (n) => ` · ${n} waiting`,
      login: 'Log in again at your login page, then the report goes out.', downloaded: 'Saved as a file. Run `papercuts import <file>` later.',
      kinds: { bug: 'bug', ux: 'ux', copy: 'copy', idea: 'idea', other: 'other' },
      markPic: 'Mark picture', markScreen: 'Mark screen', mic: 'Speak', micStop: 'Stop', pen: 'Pen', pin: 'Pin',
      undo: 'Undo', clear: 'Clear', cancel: 'Cancel', done: 'Done', pinText: 'What is at this pin?', removePic: 'Remove picture',
      cannotMark: 'This picture cannot be marked (it comes from another site).', noScreen: 'No screen picture: ',
      list: (n) => `Open papercuts (${n})`, back: 'New papercut', goto: 'Go to place', replies: (n) => ` · ${n} new ${n === 1 ? 'reply' : 'replies'}`,
      replyCount: (n) => `${n} ${n === 1 ? 'reply' : 'replies'}`, empty: 'No open papercuts.', age: (d) => (d < 1 ? 'today' : `${d} d ago`),
    },
    de: {
      tab: 'Papercut', tabTitle: 'Papercut melden (Alt+Shift+P)', title: 'Papercut', pick: 'Stelle wählen', parent: 'Größer',
      whole: 'Ganze Ansicht', kind: 'Art', placeholder: 'Ein Satz: Was stimmt nicht?', send: 'Senden', download: 'Als Datei speichern',
      close: 'Schließen', sending: 'Sende…', sent: 'Gesendet: ', writeFirst: 'Schreib zuerst einen Satz.',
      saved: 'Im Browser gespeichert. Geht später raus.', savedLogin: 'Im Browser gespeichert. Melde dich neu an, dann geht es raus.',
      notSent: 'Nicht gesendet: ', hint: 'Tippe auf die Stelle. Esc bricht ab.', waiting: (n) => ` · ${n} warten`,
      login: 'Melde dich auf der Login-Seite neu an, dann geht der Bericht raus.', downloaded: 'Als Datei gespeichert. Später `papercuts import <datei>` ausführen.',
      kinds: { bug: 'Fehler', ux: 'Bedienung', copy: 'Text', idea: 'Idee', other: 'Sonst' },
      markPic: 'Bild markieren', markScreen: 'Bildschirm markieren', mic: 'Sprechen', micStop: 'Stopp', pen: 'Stift', pin: 'Nummer',
      undo: 'Zurück', clear: 'Leeren', cancel: 'Abbrechen', done: 'Fertig', pinText: 'Was ist an dieser Nummer?', removePic: 'Bild entfernen',
      cannotMark: 'Dieses Bild lässt sich nicht markieren (es kommt von einer anderen Seite).', noScreen: 'Kein Bildschirmfoto: ',
      list: (n) => `Offene Papercuts (${n})`, back: 'Neuer Papercut', goto: 'Zur Stelle', replies: (n) => ` · ${n} neue ${n === 1 ? 'Antwort' : 'Antworten'}`,
      replyCount: (n) => `${n} ${n === 1 ? 'Antwort' : 'Antworten'}`, empty: 'Keine offenen Papercuts.', age: (d) => (d < 1 ? 'heute' : `vor ${d} T.`),
    },
  };
  const t = T[cfg.lang] || T.en;

  // A copy of the redaction in src/format.js (test/format.test.js checks that both lists match).
  // The browser redacts before it stores a report, so a queued report holds no secret either.
  // SECRET-START
  const SECRET = new RegExp([
    String.raw`(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{8,}`,
    String.raw`gh[opsur]_[A-Za-z0-9]{8,}`,
    String.raw`github_pat_\S+`,
    String.raw`xox[abprs]-[A-Za-z0-9-]{8,}`,
    String.raw`(?:Bearer|Basic)\s+\S+`,
    String.raw`AKIA[0-9A-Z]{16}`,
    String.raw`(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)`,
    String.raw`["']?(?:api[_-]?key|token|password|passwd|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)`,
  ].join('|'), 'gi');
  // SECRET-END
  const redactDeep = (v, depth = 0) => {
    if (typeof v === 'string') return v.replace(SECRET, '[redacted]');
    if (depth > 8 || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'shot' ? x : redactDeep(x, depth + 1)]));
  };

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

  function place(el) {
    return {
      url: location.href, hash: location.hash, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      viewport: { width: innerWidth, height: innerHeight }, selector: el ? cssPath(el) : '', storage: storageSubset(),
    };
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
      place: place(el),
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
        tx.oncomplete = () => resolve(mode === 'readonly' ? req.result : true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {
      return mode === 'readonly' ? [] : false;
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
    if (res.status >= 500 && data.retry !== false) return { delivered: false, transient: true, reason: 'github', data };
    if (!res.ok) return { delivered: false, transient: false, data };
    return { delivered: true, data };
  }

  const REASON = {
    offline: { error: 'the relay does not answer', help: 'the report waits in this browser and goes out later' },
    login: { error: 'the login expired', help: 'log in again, then the report goes out' },
    github: { error: 'GitHub did not take the report', help: 'the report waits in this browser and goes out later' },
  };

  let ui = { badge() {}, notice() {}, open() {}, reload() {} };
  let flushing = false;
  // All tabs of the site share one queue. The lock keeps two tabs from sending the same report at once.
  const flush = () => (navigator.locks ? navigator.locks.request('papercuts-flush', { ifAvailable: true }, (lock) => lock && flushNow()) : flushNow());
  async function flushNow() {
    if (flushing) return;
    flushing = true;
    try {
      for (const payload of await queued()) {
        const r = await send(payload);
        if (r.delivered || !r.transient) {
          await dequeue(payload.report.id);
          if (r.delivered) ui.reload();
        } else {
          if (r.reason === 'login') ui.notice(t.login);
          break;
        }
      }
    } finally {
      flushing = false;
      ui.badge();
    }
  }

  function buildPayload(input, el) {
    return redactDeep({
      from: input.from === 'human' ? 'human' : 'agent',
      report: {
        id: input.id || newId(),
        kind: input.kind,
        text: input.text,
        where: input.where,
        repo: input.repo || cfg.repo,
        context: Object.assign(autoContext(el), input.context || {}),
        ...(input.shot ? { shot: input.shot } : {}),
        ...(input.pins ? { pins: input.pins } : {}),
      },
    });
  }

  function downloadReport(input, el) {
    const payload = buildPayload(input, el);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = `papercut-${new Date().toISOString().slice(0, 10)}-${payload.report.id.slice(0, 8)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return payload;
  }

  async function report(input = {}, el) {
    const payload = buildPayload(input, el);
    const r = await send(payload);
    if (r.delivered) { ui.reload(); return r.data; }
    if (!r.transient) return Object.assign({ ok: false, queued: false }, r.data);
    if (!(await enqueue(payload))) {
      return { ok: false, queued: false, error: `${REASON[r.reason].error}, and this browser cannot save the report`, help: 'copy the text and send it again later' };
    }
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
    .row h2 { margin: 0 auto 0 0; align-self: center; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    button { border: 1px solid #111; background: #fff; border-radius: 4px; padding: 6px 10px; cursor: pointer; }
    button.send, button.primary { background: #111; color: #fff; }
    button:disabled { opacity: .5; cursor: default; }
    .target { font: 12px/1.4 ui-monospace, monospace; color: #444; word-break: break-all; }
    select, textarea { width: 100%; border: 1px solid #888; border-radius: 4px; padding: 6px; background: #fff; }
    textarea { min-height: 80px; resize: vertical; margin-top: 6px; }
    .counter { font-size: 12px; color: #666; text-align: right; margin-left: auto; align-self: center; }
    .status { min-height: 1.4em; font-size: 13px; }
    .status a { color: #111; }
    .tab.dragging { cursor: grabbing; }
    .sheet { position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 2147483647; display: flex; flex-direction: column;
      align-items: center; gap: 8px; padding: 8px; overflow: auto; }
    .sheet .row { justify-content: center; margin: 0; }
    .sheet canvas { background: #fff; touch-action: none; cursor: crosshair; max-width: 100%; }
    .sheet button[aria-pressed="true"] { background: #111; color: #fff; }
    .sheet .pins { width: min(600px, 100%); display: grid; gap: 4px; }
    .sheet .pins label { display: flex; gap: 6px; align-items: center; color: #fff; }
    .sheet .pins input { flex: 1; border: 1px solid #888; border-radius: 4px; padding: 4px 6px; background: #fff; color: #111; }
    .items { list-style: none; margin: 8px 0; padding: 0; display: grid; gap: 8px; }
    .items li { border: 1px solid #ccc; border-radius: 6px; padding: 8px; }
    .items .meta { font-size: 12px; color: #666; }
    .items .reply { font-size: 13px; border-left: 3px solid #888; padding-left: 6px; margin-top: 4px; white-space: pre-wrap; }
    .items a { color: inherit; }
    .tab .replies { color: #fc6; }
    img.preview { display: block; max-width: 100%; max-height: 120px; border: 1px solid #888; margin-top: 6px; }
    button.mic[aria-pressed="true"] { background: #d00; color: #fff; border-color: #d00; }
    .box { position: fixed; pointer-events: none; border: 2px solid #d00; background: rgba(221,0,0,.08); z-index: 2147483645; }
    .hint { position: fixed; left: 50%; top: 8px; transform: translateX(-50%); background: #111; color: #fff; padding: 6px 10px;
      border-radius: 4px; z-index: 2147483647; }
    @media (prefers-color-scheme: dark) {
      * { color: #eee; }
      .panel, button, select, textarea { background: #1a1a1a; border-color: #ccc; }
      button.send, button.primary, .tab, .hint { background: #eee; color: #111; }
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
      els.target.textContent = el ? cssPath(el) : t.whole;
      els.parent.disabled = !el || !el.parentElement || el.parentElement === document.documentElement;
      if (els.markPic) els.markPic.hidden = !pickedImage();
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
    // Inside a modal dialog, Esc is also a close request for the dialog. It must only end the picking.
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopPicking(); setTarget(picked); } };
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

    const isHidden = () => { try { return typeof window.papercutsHidden === 'function' && !!window.papercutsHidden(); } catch (_) { return false; } };

    // A modal <dialog> sits in the top layer and makes the rest of the page inert. Inside it, the widget stays usable.
    function home() {
      const modal = [...document.querySelectorAll('dialog[open]')].filter((d) => { try { return d.matches(':modal'); } catch (_) { return false; } }).pop();
      return modal || document.documentElement;
    }
    function rehome() {
      const target = home();
      if (host.parentNode !== target) target.append(host);
    }

    function open() {
      if (isHidden()) return;
      rehome();
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

    // ---- drawing sheet: a picture with pen strokes and numbered pins ----
    let mark = null; // { shot, pins } after "Done"
    const sheet = { marks: [], tool: 'pen', img: null, canvas: null, ctx: null, drawing: null };

    function lineWidth() { return Math.max(3, Math.round(Math.max(sheet.canvas.width, sheet.canvas.height) / 220)); }
    function redraw() {
      const { ctx, canvas } = sheet;
      ctx.drawImage(sheet.img, 0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#e00'; ctx.lineWidth = lineWidth();
      let nr = 0;
      for (const m of sheet.marks) {
        if (m.type === 'pen') {
          ctx.beginPath();
          m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        } else {
          nr++;
          const r = lineWidth() * 3;
          ctx.fillStyle = '#e00'; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(nr), m.x, m.y);
        }
      }
    }
    function renderPins() {
      els.pins.replaceChildren(...sheet.marks.filter((m) => m.type === 'pin').map((m, i) => {
        const input = h('input', { type: 'text', maxlength: '120', placeholder: t.pinText, 'aria-label': `${i + 1}` });
        input.value = m.text;
        input.addEventListener('input', () => { m.text = input.value; });
        return h('label', {}, `${i + 1}.`, input);
      }));
    }
    function point(e) {
      const r = sheet.canvas.getBoundingClientRect();
      return [Math.round((e.clientX - r.left) * (sheet.canvas.width / r.width)), Math.round((e.clientY - r.top) * (sheet.canvas.height / r.height))];
    }
    function setTool(tool) {
      sheet.tool = tool;
      els.toolPen.setAttribute('aria-pressed', String(tool === 'pen'));
      els.toolPin.setAttribute('aria-pressed', String(tool === 'pin'));
    }
    function openSheet(source) {
      // The long side stays at most 2000 px, so the PNG stays well under the 8 MB limit.
      const w = source.naturalWidth || source.videoWidth || source.width;
      const hgt = source.naturalHeight || source.videoHeight || source.height;
      const scale = Math.min(1, 2000 / Math.max(w, hgt));
      const canvas = h('canvas', {});
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(hgt * scale));
      // Show it as large as the screen allows, at least 2x a small picture.
      const fit = Math.min((innerWidth - 16) / canvas.width, (innerHeight - 200) / canvas.height, Math.max(2, 1));
      canvas.style.width = `${Math.round(canvas.width * fit)}px`;
      canvas.style.height = `${Math.round(canvas.height * fit)}px`;
      Object.assign(sheet, { marks: [], img: source, canvas, ctx: canvas.getContext('2d'), drawing: null });
      canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const p = point(e);
        if (sheet.tool === 'pin') { sheet.marks.push({ type: 'pin', x: p[0], y: p[1], text: '' }); renderPins(); redraw(); return; }
        sheet.drawing = { type: 'pen', points: [p] };
        sheet.marks.push(sheet.drawing);
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => { if (sheet.drawing) { sheet.drawing.points.push(point(e)); redraw(); } });
      const stop = () => { sheet.drawing = null; };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
      els.canvasSlot.replaceChildren(canvas);
      setTool('pen');
      renderPins();
      redraw();
      els.panel.hidden = true;
      els.box.hidden = true;
      els.sheet.hidden = false;
    }
    function closeSheet() {
      els.sheet.hidden = true;
      els.panel.hidden = false;
    }
    // The relay takes at most 8 MB of PNG. A photo can be larger even at 2000 px: scale down until it fits.
    const MAX_SHOT_CHARS = Math.floor((8 * 1024 * 1024 * 4) / 3) - 1024;
    function shotData(canvas) {
      let c = canvas;
      let data = c.toDataURL('image/png');
      while (data.length > MAX_SHOT_CHARS && c.width > 64) {
        const next = document.createElement('canvas');
        next.width = Math.round(c.width * 0.7);
        next.height = Math.round(c.height * 0.7);
        next.getContext('2d').drawImage(c, 0, 0, next.width, next.height);
        c = next;
        data = c.toDataURL('image/png');
      }
      return data;
    }
    function finishSheet() {
      redraw();
      const pins = sheet.marks.filter((m) => m.type === 'pin').map((m, i) => ({ nr: i + 1, text: m.text.trim() }));
      mark = { shot: shotData(sheet.canvas), pins };
      els.preview.src = mark.shot;
      els.previewRow.hidden = false;
      closeSheet();
    }
    function forgetMark() {
      mark = null;
      els.preview.removeAttribute('src');
      els.previewRow.hidden = true;
    }
    function pickedImage() {
      if (!picked) return null;
      return picked.localName === 'img' ? picked : picked.querySelector && picked.querySelector('img');
    }
    function markPicture() {
      const src = pickedImage();
      if (!src) return;
      // Load it again with CORS. A picture from another site without CORS would taint the canvas.
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => openSheet(img);
      img.onerror = () => { els.status.textContent = t.cannotMark; };
      img.src = src.currentSrc || src.src;
    }
    const canCapture = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && matchMedia('(pointer: fine)').matches;
    async function markScreen() {
      els.panel.hidden = true;
      els.tab.hidden = true;
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true });
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        await new Promise((r) => setTimeout(r, 250));
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach((tr) => tr.stop());
        els.tab.hidden = false;
        openSheet(c);
      } catch (e) {
        els.tab.hidden = false;
        els.panel.hidden = false;
        els.status.textContent = t.noScreen + ((e && (e.message || e.name)) || 'cancelled');
      }
    }

    // ---- voice input ----
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    let listening = null;
    function toggleMic() {
      if (listening) { listening.stop(); return; }
      const rec = new Speech();
      rec.lang = cfg.lang === 'de' ? 'de-DE' : 'en-US';
      rec.interimResults = false;
      rec.continuous = true;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const said = e.results[i][0].transcript.trim();
            els.text.value = `${els.text.value} ${said}`.trim().slice(0, 300);
            els.counter.textContent = `${els.text.value.length} / 300`;
          }
        }
      };
      rec.onend = () => { listening = null; els.mic.setAttribute('aria-pressed', 'false'); els.mic.textContent = t.mic; };
      rec.onerror = (e) => { els.status.textContent = `${t.mic}: ${e.error}`; };
      listening = rec;
      els.mic.setAttribute('aria-pressed', 'true');
      els.mic.textContent = t.micStop;
      rec.start();
    }

    // ---- list of open papercuts ----
    let items = [];
    const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (_) { return {}; } };
    const unseen = () => { const s = seen(); return items.filter((i) => i.replyCount > (s[i.issue] || 0)).length; };
    function markSeen() {
      const s = seen();
      for (const i of items) s[i.issue] = i.replyCount;
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (_) { /* no badge memory */ }
      els.replies.textContent = '';
    }
    async function loadList() {
      if (!cfg.repo) return;
      try {
        const res = await fetch(`${relay}/list?repo=${encodeURIComponent(cfg.repo)}`, { credentials: 'include', redirect: 'manual' });
        const data = res.ok ? await res.json() : null;
        if (!data || !data.ok) { els.listBtn.hidden = true; return; }
        items = data.items || [];
      } catch (_) { els.listBtn.hidden = true; return; }
      els.listBtn.hidden = false;
      els.listBtn.textContent = t.list(items.length);
      const n = unseen();
      els.replies.textContent = n ? t.replies(n) : '';
      if (!els.listView.hidden) renderList();
    }
    function goTo(p) {
      let u;
      try { u = new URL(p.url); } catch (_) { return; }
      // The place comes from a report. Never follow a javascript: or data: URL.
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      if (u.origin !== location.origin || u.pathname !== location.pathname) { location.href = p.url; return; }
      if (p.hash && location.hash !== p.hash) location.hash = p.hash;
      close();
      setTimeout(() => scrollTo(p.scrollX || 0, p.scrollY || 0), 50);
    }
    function renderList() {
      const days = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000));
      els.items.replaceChildren(...(items.length ? items.map((i) => {
        const last = i.replies && i.replies[i.replies.length - 1];
        return h('li', { 'data-issue': String(i.issue) },
          h('div', {}, h('a', { href: i.url, target: '_blank', rel: 'noopener' }, `#${i.issue}`), ` ${i.title}`),
          h('div', { class: 'meta' }, `${t.kinds[i.kind] || i.kind} · ${t.age(days(i.created))} · ${t.replyCount(i.replyCount)}${i.plus ? ` · +${i.plus}` : ''}`),
          ...(last ? [h('div', { class: 'reply' }, last.text)] : []),
          ...(i.place && /^https?:\/\//i.test(i.place.url || '') ? [h('div', { class: 'row' }, h('button', { type: 'button', class: 'goto', onclick: () => goTo(i.place) }, t.goto))] : []));
      }) : [h('li', {}, t.empty)]));
    }
    function showList(on) {
      els.listView.hidden = !on;
      els.form.hidden = on;
      els.listBtn.textContent = on ? t.back : t.list(items.length);
      if (on) { renderList(); markSeen(); }
    }

    const clearForm = () => { els.text.value = ''; els.counter.textContent = '0 / 300'; forgetMark(); };

    async function submit() {
      const text = els.text.value.trim();
      if (!text) { els.status.textContent = t.writeFirst; return; }
      const input = { kind: els.kind.value, text, from: 'human', ...(mark || {}) };
      if (DOWNLOAD) {
        downloadReport(input, picked);
        clearForm();
        els.status.textContent = t.downloaded;
        return;
      }
      els.send.disabled = true;
      els.status.textContent = t.sending;
      const r = await window.papercuts.report({ ...input, _el: picked });
      els.send.disabled = false;
      els.status.textContent = '';
      if (r.ok) {
        els.status.append(t.sent, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, `#${r.issue}`));
        clearForm();
      } else if (r.queued) {
        els.status.textContent = /log in/.test(r.error) ? t.savedLogin : t.saved;
      } else {
        els.status.textContent = `${t.notSent}${r.error}. ${r.help || ''}`;
      }
    }

    // The tab can be dragged up and down. A short press without a move is a click.
    function makeDraggable(tab) {
      let start = null;
      let moved = false;
      tab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        start = { y: e.clientY, top: tab.getBoundingClientRect().top + tab.offsetHeight / 2 };
        moved = false;
        tab.setPointerCapture(e.pointerId);
      });
      tab.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dy = e.clientY - start.y;
        if (!moved && Math.abs(dy) < 6) return;
        moved = true;
        tab.classList.add('dragging');
        const mid = Math.min(innerHeight - 40, Math.max(40, start.top + dy));
        tab.style.top = `${(mid / innerHeight) * 100}%`;
      });
      const end = () => {
        if (!start) return;
        start = null;
        tab.classList.remove('dragging');
        if (moved) { try { localStorage.setItem(POS_KEY, tab.style.top); } catch (_) { /* position for this page only */ } }
      };
      tab.addEventListener('pointerup', end);
      tab.addEventListener('pointercancel', end);
      tab.addEventListener('click', (e) => { if (moved) { e.preventDefault(); moved = false; return; } toggle(); });
      try { const top = localStorage.getItem(POS_KEY); if (/^\d+(\.\d+)?%$/.test(top || '')) tab.style.top = top; } catch (_) { /* default place */ }
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
    els.replies = h('span', { class: 'replies' });
    els.tab = h('button', { class: 'tab', type: 'button', title: t.tabTitle }, t.tab, els.count, els.replies);
    makeDraggable(els.tab);
    els.target = h('div', { class: 'target' });
    els.parent = h('button', { type: 'button', class: 'parent', onclick: () => picked && setTarget(picked.parentElement) }, t.parent);
    els.kind = h('select', { 'aria-label': t.kind }, ...KINDS.map((k) => h('option', { value: k }, t.kinds[k])));
    els.text = h('textarea', { maxlength: '300', placeholder: t.placeholder, 'aria-label': t.title });
    els.counter = h('div', { class: 'counter' }, '0 / 300');
    els.text.addEventListener('input', () => { els.counter.textContent = `${els.text.value.length} / 300`; });
    els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    els.send = h('button', { type: 'button', class: 'send', onclick: submit }, DOWNLOAD ? t.download : t.send);
    els.status = h('div', { class: 'status', role: 'status' });
    els.markPic = h('button', { type: 'button', class: 'mark-pic', hidden: '', onclick: markPicture }, t.markPic);
    els.markScreen = h('button', { type: 'button', class: 'mark-screen', onclick: markScreen }, t.markScreen);
    els.markScreen.hidden = !canCapture();
    els.mic = h('button', { type: 'button', class: 'mic', 'aria-pressed': 'false', onclick: toggleMic }, t.mic);
    els.mic.hidden = !Speech;
    els.preview = h('img', { class: 'preview', alt: '' });
    els.previewRow = h('div', { hidden: '' }, els.preview, h('div', { class: 'row' }, h('button', { type: 'button', class: 'remove-pic', onclick: forgetMark }, t.removePic)));
    els.toolPen = h('button', { type: 'button', class: 'tool-pen', onclick: () => setTool('pen') }, t.pen);
    els.toolPin = h('button', { type: 'button', class: 'tool-pin', onclick: () => setTool('pin') }, t.pin);
    els.canvasSlot = h('div', {});
    els.pins = h('div', { class: 'pins' });
    els.sheet = h('div', { class: 'sheet', hidden: '' },
      h('div', { class: 'row' }, els.toolPen, els.toolPin,
        h('button', { type: 'button', class: 'undo', onclick: () => { sheet.marks.pop(); renderPins(); redraw(); } }, t.undo),
        h('button', { type: 'button', class: 'clear', onclick: () => { sheet.marks = []; renderPins(); redraw(); } }, t.clear),
        h('button', { type: 'button', class: 'cancel', onclick: closeSheet }, t.cancel),
        h('button', { type: 'button', class: 'done primary', onclick: finishSheet }, t.done)),
      els.canvasSlot, els.pins);
    els.listBtn = h('button', { type: 'button', class: 'list', hidden: '', onclick: () => showList(els.listView.hidden) }, t.list(0));
    els.items = h('ul', { class: 'items' });
    els.listView = h('div', { hidden: '' }, els.items);
    els.form = h('div', {},
      els.target,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'pick', onclick: startPicking }, t.pick),
        els.parent,
        h('button', { type: 'button', class: 'whole', onclick: () => setTarget(null) }, t.whole)),
      h('div', { class: 'row' }, els.markPic, els.markScreen),
      els.previewRow,
      els.kind, els.text,
      h('div', { class: 'row' }, els.mic, els.counter),
      h('div', { class: 'row' }, els.send, h('button', { type: 'button', class: 'close', onclick: close }, t.close)));
    els.panel = h('div', { class: 'panel', hidden: '' },
      h('div', { class: 'row' }, h('h2', {}, t.title), els.listBtn),
      els.form, els.listView, els.status);
    els.box = h('div', { class: 'box', hidden: '' });
    els.hint = h('div', { class: 'hint', hidden: '' }, t.hint);
    shadow.append(els.box, els.hint, els.tab, els.panel, els.sheet);
    document.documentElement.append(host);
    setTarget(null);
    els.box.hidden = true;
    addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyP') { e.preventDefault(); toggle(); }
    });
    new MutationObserver(rehome).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    // The page decides when the widget hides, for example in a print or kids view.
    const applyHidden = () => {
      const hide = isHidden();
      els.tab.hidden = hide;
      if (hide && !els.panel.hidden) close();
    };
    applyHidden();
    setInterval(applyHidden, 1000);
    if (!DOWNLOAD) {
      loadList();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadList(); });
    }

    return {
      open,
      async badge() {
        const n = (await queued()).length;
        els.count.textContent = n ? t.waiting(n) : '';
      },
      notice(text) { els.status.textContent = text; },
      reload: () => loadList(),
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
    if (DOWNLOAD) { ui = createUi(); return; }
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
