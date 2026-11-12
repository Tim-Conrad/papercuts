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
  // The ticket config of the repo (.github/papercuts.json), from the relay. Page attributes win over it.
  let repoCfg = null;
  const kindsList = () => (repoCfg && repoCfg.kinds && repoCfg.kinds.length ? repoCfg.kinds : KINDS);
  const presetList = () => (repoCfg && repoCfg.presets) || [];
  // ?papercuts=download or data-mode="download": no relay, the report becomes a file for `papercuts import`.
  const DOWNLOAD = new URLSearchParams(location.search).get('papercuts') === 'download' || cfg.mode === 'download';
  const errors = [];

  // All words of the widget, one table per language. The JS API answers in English for agents.
  // A site adds or changes a language with window.papercutsStrings = { fr: { send: 'Envoyer', ... } }.
  // A missing word falls back to English.
  const T = {
    en: {
      tab: 'Papercut', tabTitle: 'Report a papercut (Alt+Shift+P)', title: 'Papercut', pick: 'Mark', parent: 'Larger', child: 'Smaller',
      whole: 'Whole view', wholeSub: 'The part of the page that you see', kind: 'Kind', placeholder: 'What is wrong? One sentence is enough.', send: 'Send', download: 'Download report',
      close: 'Close', sending: 'Sending…', sent: 'Sent: ', writeFirst: 'Write one sentence first.',
      saved: 'Saved in this browser. It goes out later.', savedLogin: 'Saved in this browser. Log in again, then it goes out.',
      notSent: 'Not sent: ', hint: 'Tap or click the part you mean', waiting: (n) => ` · ${n} waiting`,
      login: 'Log in again at your login page, then the report goes out.', downloaded: 'Saved as a file. Run `papercuts import <file>` later.',
      kinds: { bug: 'Bug', ux: 'Hard to use', copy: 'Wording', idea: 'Idea', other: 'Other', tool: 'Tool', rule: 'Rule', path: 'Path' },
      markPic: 'Mark picture', markScreen: 'Mark screen', mic: 'Speak', micStop: 'Stop', pen: 'Pen', pin: 'Pin',
      undo: 'Undo', clear: 'Clear', cancel: 'Cancel', done: 'Done', pinText: 'What is at this pin?', removePic: 'Remove picture',
      cannotMark: 'This picture cannot be marked (it comes from another site).', noScreen: 'No screen picture: ',
      list: (o, f) => [o || !f ? `${o} open` : '', f ? `${f} fixed` : ''].filter(Boolean).join(' · '), back: 'New papercut', pickedSub: 'Picked element', pins: (n) => `${n} ${n === 1 ? 'pin' : 'pins'}`, picture: 'Marked picture', cancelPick: 'Cancel', goto: 'Go to place', replies: (n) => ` · ${n} new ${n === 1 ? 'reply' : 'replies'}`,
      replyCount: (n) => `${n} ${n === 1 ? 'reply' : 'replies'}`, empty: 'No open papercuts.', age: (d) => (d < 1 ? 'today' : `${d} d ago`),
      fixed: 'Fixed', required: 'required', fieldRequired: (l) => `Fill in “${l}”, it is required.`, speak: 'Tap to speak', listening: 'Listening… tap to stop', typeInstead: 'or type below',
      toolTap: 'Tap', toolBox: 'Box', toolDraw: 'Draw', markDone: 'Done', note: 'Note (optional)', region: (w, h) => `Region ${w}×${h}`,
      hintTap: 'Tap the parts you mean. Tap again to remove.', hintBox: 'Drag a box around a region.', hintDraw: 'Tap a picture to draw on it.',
      removeMark: (n) => `Remove mark ${n}`,
      another: 'Report another', thanks: 'Thank you. Sent as ', twoFingers: 'Hold two fingers', copyLink: 'Copy link', copied: 'Link copied',
      loginFirst: 'Log in to report. Open the login page, then come back: ', loginLink: 'log in',
      micBlocked: 'Microphone blocked. Allow it in the browser settings, or type instead.', noSpeech: 'I heard nothing. Tap and speak again, or type instead.',
      micNetwork: 'Speech input needs a network connection. Type instead.', micFailed: 'Speech input failed. Type instead.', pinLabel: (n) => `Pin ${n}: what is here?`,
    },
    de: {
      tab: 'Papercut', tabTitle: 'Papercut melden (Alt+Shift+P)', title: 'Papercut', pick: 'Markieren', parent: 'Größer', child: 'Kleiner',
      whole: 'Ganze Ansicht', wholeSub: 'Der Teil der Seite, den du siehst', kind: 'Art', placeholder: 'Was stimmt nicht? Ein Satz reicht.', send: 'Senden', download: 'Als Datei speichern',
      close: 'Schließen', sending: 'Sende…', sent: 'Gesendet: ', writeFirst: 'Schreib zuerst einen Satz.',
      saved: 'Im Browser gespeichert. Geht später raus.', savedLogin: 'Im Browser gespeichert. Melde dich neu an, dann geht es raus.',
      notSent: 'Nicht gesendet: ', hint: 'Tippe oder klicke auf die Stelle', waiting: (n) => ` · ${n} warten`,
      login: 'Melde dich auf der Login-Seite neu an, dann geht der Bericht raus.', downloaded: 'Als Datei gespeichert. Später `papercuts import <datei>` ausführen.',
      kinds: { bug: 'Fehler', ux: 'Schwer zu bedienen', copy: 'Text', idea: 'Idee', other: 'Sonst', tool: 'Werkzeug', rule: 'Regel', path: 'Pfad' },
      markPic: 'Bild markieren', markScreen: 'Bildschirm markieren', mic: 'Sprechen', micStop: 'Stopp', pen: 'Stift', pin: 'Nummer',
      undo: 'Zurück', clear: 'Leeren', cancel: 'Abbrechen', done: 'Fertig', pinText: 'Was ist an dieser Nummer?', removePic: 'Bild entfernen',
      cannotMark: 'Dieses Bild lässt sich nicht markieren (es kommt von einer anderen Seite).', noScreen: 'Kein Bildschirmfoto: ',
      list: (o, f) => [o || !f ? `${o} offen` : '', f ? `${f} behoben` : ''].filter(Boolean).join(' · '), back: 'Neuer Papercut', pickedSub: 'Gewähltes Element', pins: (n) => `${n} ${n === 1 ? 'Nummer' : 'Nummern'}`, picture: 'Markiertes Bild', cancelPick: 'Abbrechen', goto: 'Zur Stelle', replies: (n) => ` · ${n} neue ${n === 1 ? 'Antwort' : 'Antworten'}`,
      replyCount: (n) => `${n} ${n === 1 ? 'Antwort' : 'Antworten'}`, empty: 'Keine offenen Papercuts.', age: (d) => (d < 1 ? 'heute' : `vor ${d} T.`),
      fixed: 'Behoben', required: 'Pflicht', fieldRequired: (l) => `Fülle „${l}“ aus, das ist Pflicht.`, speak: 'Tippen und sprechen', listening: 'Ich höre zu… tippen zum Beenden', typeInstead: 'oder unten tippen',
      toolTap: 'Tippen', toolBox: 'Rahmen', toolDraw: 'Zeichnen', markDone: 'Fertig', note: 'Notiz (optional)', region: (w, h) => `Bereich ${w}×${h}`,
      hintTap: 'Tippe auf die Stellen. Noch einmal tippen entfernt sie.', hintBox: 'Ziehe einen Rahmen um einen Bereich.', hintDraw: 'Tippe auf ein Bild, um darauf zu zeichnen.',
      removeMark: (n) => `Markierung ${n} entfernen`,
      another: 'Noch einen melden', thanks: 'Danke. Gesendet als ', twoFingers: 'Mit zwei Fingern halten', copyLink: 'Link kopieren', copied: 'Link kopiert',
      loginFirst: 'Zum Melden anmelden. Öffne die Login-Seite und komm zurück: ', loginLink: 'anmelden',
      micBlocked: 'Mikrofon blockiert. Erlaube es in den Browser-Einstellungen oder tippe.', noSpeech: 'Ich habe nichts gehört. Tippe und sprich noch einmal oder tippe.',
      micNetwork: 'Spracheingabe braucht Netz. Tippe stattdessen.', micFailed: 'Spracheingabe ging nicht. Tippe stattdessen.', pinLabel: (n) => `Nummer ${n}: Was ist hier?`,
    },
  };
  let t = T.en;
  function strings() {
    const lang = cfg.lang || (repoCfg && repoCfg.lang) || 'en';
    let own = {};
    try { own = (window.papercutsStrings && window.papercutsStrings[lang]) || {}; } catch (_) { own = {}; }
    const kinds = Object.assign({}, T.en.kinds, (T[lang] || {}).kinds, own.kinds);
    return Object.assign({}, T.en, T[lang] || {}, own, { kinds });
  }

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

  // data-storage="*" takes every key except those in data-storage-skip (for example a room code).
  function storageSubset() {
    const ctxCfg = (repoCfg && repoCfg.context) || {};
    let keys = (cfg.storage || (ctxCfg.storage || []).join(',')).split(',').map((k) => k.trim()).filter(Boolean);
    if (!keys.length) return undefined;
    if (keys.length === 1 && keys[0] === '*') {
      const skip = new Set((cfg.storageSkip || (ctxCfg.skipStorage || []).join(',')).split(',').map((k) => k.trim()).filter(Boolean));
      keys = [];
      try { for (let i = 0; i < localStorage.length && keys.length < 50; i++) { const k = localStorage.key(i); if (!skip.has(k)) keys.push(k); } } catch (_) { /* storage blocked */ }
    }
    const out = {};
    for (const k of keys) {
      try { const v = localStorage.getItem(k); if (v !== null) out[k] = v.slice(0, 300); } catch (_) { /* storage blocked */ }
    }
    return out;
  }

  function place(el) {
    let steps;
    try { steps = typeof window.papercutsReplay === 'function' ? window.papercutsReplay() : undefined; } catch (_) { steps = undefined; }
    return {
      url: location.href, hash: location.hash, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      viewport: { width: innerWidth, height: innerHeight }, selector: el ? cssPath(el) : '', storage: storageSubset(),
      ...(Array.isArray(steps) ? { steps } : {}),
    };
  }

  function autoContext(el) {
    let site;
    // The page can add its own fields. It gets the first marked element, or null for the whole view.
    try { site = typeof window.papercutsContext === 'function' ? window.papercutsContext(el || null) : undefined; } catch (e) { site = { error: String(e) }; }
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
    const payload = redactDeep({
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
        ...(input.fields && typeof input.fields === 'object' ? { fields: input.fields } : {}),
        ...(Array.isArray(input.marks) ? { marks: input.marks } : {}),
      },
    });
    // Where each mark is, for papercuts replay.
    if (Array.isArray(input.placeMarks) && payload.report.context.place) payload.report.context.place.marks = input.placeMarks;
    return payload;
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
    let login = false;
    let reason = '';
    try {
      const res = await fetch(`${relay}/status`, { credentials: 'include', redirect: 'manual' });
      login = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
      reachable = res.ok && (await res.json()).ok === true;
      if (!reachable && !login) reason = `HTTP ${res.status}`;
    } catch (e) {
      reason = (e && e.message) || 'no answer';
      // A login proxy answers with a redirect without CORS headers, so the readable request fails like a dead relay.
      // An opaque request tells them apart: it fails only when nothing answers.
      try {
        await fetch(`${relay}/status`, { mode: 'no-cors', credentials: 'include' });
        login = true;
        console.warn(`papercuts: relay ${relay} answers, but the page cannot read it: the login of the relay ended, or this origin is not in PAPERCUTS_ORIGINS`);
      } catch (_) { /* nothing answers */ }
    }
    return { reachable, login, reason, queued: (await queued()).length };
  }

  // ---- UI ----
  // Design tokens: one accent (data-accent), neutral surfaces, light and dark. Shadow DOM keeps the page CSS out.
  const CSS_TEXT = `
    :host { all: initial;
      --pc-accent: #d13438; --pc-on-accent: #fff;
      --pc-bg: #ffffff; --pc-surface: #f4f4f5; --pc-hover: #ececef; --pc-line: rgba(24,24,27,.11);
      --pc-ink: #18181b; --pc-muted: #6b6b75; --pc-ok: #15803d; --pc-warn: #b45309; --pc-err: #dc2626;
      --pc-shadow: 0 24px 60px -16px rgba(9,9,11,.32), 0 6px 16px -6px rgba(9,9,11,.14);
      --pc-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --pc-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (prefers-color-scheme: dark) { :host {
      --pc-bg: #1b1b1f; --pc-surface: #26262b; --pc-hover: #303036; --pc-line: rgba(255,255,255,.11);
      --pc-ink: #f4f4f5; --pc-muted: #a1a1aa; --pc-ok: #4ade80; --pc-warn: #fbbf24; --pc-err: #f87171;
      --pc-shadow: 0 24px 60px -16px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.06); } }
    *, *::before, *::after { box-sizing: border-box; }
    * { font-family: var(--pc-font); font-size: 14px; line-height: 1.45; color: var(--pc-ink); -webkit-font-smoothing: antialiased; }
    [hidden] { display: none !important; }
    button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    button:disabled { cursor: default; }
    :is(button, a, textarea, input):focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 2px; }
    .ico { display: inline-flex; width: 18px; height: 18px; flex: none; }
    .ico svg { width: 100%; height: 100%; display: block; }
    .ico * { color: inherit; }

    /* the tab on the edge */
    .tab { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147483646;
      display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 8px 14px;
      background: var(--pc-ink); border-radius: 14px 0 0 14px; box-shadow: -4px 6px 20px -6px rgba(0,0,0,.35);
      transition: padding .18s ease, opacity .18s ease, transform .22s cubic-bezier(.2,.8,.2,1); touch-action: none; user-select: none; }
    .tab, .tab * { color: var(--pc-bg); }
    .tab:hover { padding-right: 11px; }
    .tab .label { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 12px; font-weight: 650; letter-spacing: .03em; }
    .bubble { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--pc-accent);
      font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .tab .bubble, .tab .bubble * { color: var(--pc-on-accent); }
    .tab .count { background: #f59e0b; }
    .bubble:empty { display: none; }
    .tab.away { opacity: 0; pointer-events: none; transform: translate(110%, -50%); }
    .tab.dragging { cursor: grabbing; transition: none; }

    /* the panel: a card on desktop, a bottom sheet on a phone */
    .scrim { position: fixed; inset: 0; z-index: 2147483646; background: rgba(9,9,11,.4); display: none; animation: pc-fade .2s ease; }
    .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(392px, calc(100vw - 32px));
      max-height: min(740px, calc(100vh - 32px)); display: flex; flex-direction: column; overflow: hidden;
      background: var(--pc-bg); border: 1px solid var(--pc-line); border-radius: 18px; box-shadow: var(--pc-shadow);
      animation: pc-in .2s cubic-bezier(.2,.8,.2,1); }
    .grab { display: none; width: 38px; height: 4px; border-radius: 2px; background: var(--pc-line); margin: 8px auto -4px; flex: none; }
    .head { display: flex; align-items: center; gap: 6px; padding: 12px 10px 12px 16px; flex: none; }
    .head h2 { margin: 0 auto 0 0; display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    .head h2 .ico { color: var(--pc-accent); }
    .body { padding: 2px 16px 14px; overflow: auto; display: grid; gap: 12px; overscroll-behavior: contain; }
    .foot { padding: 12px 16px 16px; border-top: 1px solid var(--pc-line); display: grid; gap: 10px; flex: none; }
    @media (max-width: 600px) {
      .scrim { display: block; }
      .panel { left: 0; right: 0; bottom: 0; width: 100%; max-height: 88vh; border-radius: 22px 22px 0 0; border-bottom: 0;
        animation-name: pc-up; padding-bottom: env(safe-area-inset-bottom); }
      .grab { display: block; }
    }
    .iconbtn { width: 36px; height: 36px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--pc-muted); }
    .iconbtn:hover { background: var(--pc-hover); color: var(--pc-ink); }
    .pill { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border-radius: 999px;
      border: 1px solid var(--pc-line); background: var(--pc-bg); font-size: 13px; font-weight: 560; white-space: nowrap; transition: border-color .15s, background .15s; }
    .pill:hover { background: var(--pc-hover); }
    .pill .ico { width: 16px; height: 16px; color: var(--pc-muted); }
    .pill .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--pc-accent); margin-right: -3px; }
    .pill .dot:empty { display: block; }

    /* where: the picked element */
    .where { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-radius: 14px; background: var(--pc-surface); }
    .where > .ico { color: var(--pc-muted); }
    .target { flex: 1; min-width: 0; display: grid; }
    .target .name { font-size: 13.5px; font-weight: 600; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .target .name.el { font: 500 12.5px/1.35 var(--pc-mono); }
    .target .sub { font-size: 12px; color: var(--pc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; color: var(--pc-muted); }
    .mini .ico { width: 16px; height: 16px; }
    .mini:hover:not(:disabled) { background: var(--pc-hover); color: var(--pc-ink); }
    .mini:disabled { opacity: .3; }
    .where .pill { height: 32px; background: var(--pc-bg); }

    /* kind */
    .kinds { display: flex; flex-wrap: wrap; gap: 6px; }
    .kinds button { height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--pc-line); font-size: 13px; font-weight: 560; color: var(--pc-muted); transition: all .15s; }
    .kinds button:hover { color: var(--pc-ink); }
    .kinds button[aria-checked="true"] { background: var(--pc-ink); border-color: var(--pc-ink); color: var(--pc-bg); }

    /* the sentence */
    .field { border: 1px solid var(--pc-line); border-radius: 14px; background: var(--pc-bg); transition: border-color .15s, box-shadow .15s; }
    .field:focus-within { border-color: color-mix(in srgb, var(--pc-ink) 38%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--pc-ink) 7%, transparent); }
    textarea { display: block; width: 100%; min-height: 88px; max-height: 220px; resize: none; border: 0; outline: 0; background: transparent;
      padding: 12px 14px 2px; font-size: 15px; line-height: 1.5; }
    textarea::placeholder { color: var(--pc-muted); opacity: .85; }
    textarea:focus-visible { outline: 0; }
    .fieldbar { display: flex; align-items: center; gap: 2px; padding: 4px 6px 6px; }
    .counter { margin-left: auto; padding-right: 6px; font-size: 12px; color: var(--pc-muted); font-variant-numeric: tabular-nums; }
    .counter.near { color: var(--pc-warn); font-weight: 600; }
    .mic[aria-pressed="true"] { background: var(--pc-err); color: #fff; animation: pc-pulse 1.4s ease-in-out infinite; }
    .mic[aria-pressed="true"] * { color: #fff; }

    /* quick phrases and fields */
    .presets { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 -16px; padding: 0 16px;
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 28px), transparent); }
    .presets::-webkit-scrollbar { display: none; }
    .presets button { flex: none; height: 30px; padding: 0 12px; border-radius: 999px; background: var(--pc-surface); font-size: 13px; color: var(--pc-ink); white-space: nowrap; }
    .presets button:hover { background: var(--pc-hover); }
    .fields { display: grid; gap: 10px; }
    .fields .fld { display: grid; gap: 6px; }
    .fields .fld > span { font-size: 12.5px; font-weight: 600; color: var(--pc-muted); }
    .fields .req { font-weight: 500; color: var(--pc-accent); margin-left: 4px; }
    .fields input { height: 40px; border: 1px solid var(--pc-line); border-radius: 11px; padding: 0 12px; background: var(--pc-bg); font-size: 14px; color: var(--pc-ink); outline: 0; }
    .fields input:focus { border-color: color-mix(in srgb, var(--pc-ink) 38%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--pc-ink) 7%, transparent); }
    .fields .options { display: flex; flex-wrap: wrap; gap: 6px; }
    .fields .options button { height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--pc-line); font-size: 13px; font-weight: 560; color: var(--pc-muted); }
    .fields .options button[aria-checked="true"] { background: var(--pc-ink); border-color: var(--pc-ink); color: var(--pc-bg); }
    .fields .invalid input, .fields .invalid .options { box-shadow: 0 0 0 2px color-mix(in srgb, var(--pc-err) 50%, transparent); border-radius: 11px; }

    /* voice first on a phone: speech, quick phrases and text lead, the rest follows */
    .body.voice > .speakwrap { order: -3; } .body.voice > .presets { order: -2; } .body.voice > .field { order: -1; }
    .speakwrap { display: grid; justify-items: center; gap: 8px; padding: 6px 0 2px; }
    button.speak { width: 76px; height: 76px; border-radius: 999px; background: var(--pc-accent); display: inline-flex; align-items: center; justify-content: center;
      box-shadow: 0 12px 28px -10px color-mix(in srgb, var(--pc-accent) 80%, transparent); transition: transform .1s; }
    button.speak .ico { width: 32px; height: 32px; }
    button.speak, button.speak * { color: var(--pc-on-accent); }
    button.speak:active { transform: scale(.96); }
    button.speak[aria-pressed="true"] { animation: pc-ring 1.4s ease-out infinite; }
    .speakwrap .hint2 { font-size: 13px; font-weight: 600; } .speakwrap .hint3 { font-size: 12px; color: var(--pc-muted); margin-top: -6px; }
    @keyframes pc-ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pc-accent) 45%, transparent); } 100% { box-shadow: 0 0 0 22px transparent; } }

    /* picture */
    .attach { display: flex; flex-wrap: wrap; gap: 8px; }
    .attach:not(:has(> :not([hidden]))) { display: none; }
    .shot { position: relative; display: flex; gap: 12px; align-items: center; padding: 8px; border: 1px solid var(--pc-line); border-radius: 14px; }
    img.preview { display: block; width: 84px; height: 60px; object-fit: cover; border-radius: 9px; background: var(--pc-surface); }
    .shot .meta { flex: 1; min-width: 0; font-size: 13px; color: var(--pc-muted); }
    .shot .meta strong { display: block; color: var(--pc-ink); font-weight: 600; }

    /* footer */
    .sendrow { display: flex; align-items: center; gap: 10px; }
    button.send { flex: 1; height: 44px; border-radius: 12px; background: var(--pc-accent); color: var(--pc-on-accent); font-size: 14.5px; font-weight: 650;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px; transition: filter .15s, transform .05s;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 8px 18px -8px color-mix(in srgb, var(--pc-accent) 70%, transparent); }
    button.send:hover:not(:disabled) { filter: brightness(1.06); }
    button.send:active:not(:disabled) { transform: translateY(1px); }
    button.send:disabled { opacity: .55; }
    button.send.busy::before { content: ""; width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4);
      border-top-color: #fff; animation: pc-spin .7s linear infinite; }
    .kbd { font: 11px/1 var(--pc-mono); color: var(--pc-muted); padding: 5px 7px; border: 1px solid var(--pc-line); border-radius: 7px; white-space: nowrap; }
    @media (pointer: coarse) { .kbd { display: none; } }
    .status { display: flex; gap: 9px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; background: var(--pc-surface); font-size: 13px; animation: pc-fade .2s; }
    .status:empty { display: none; }
    .status .ico { width: 17px; height: 17px; margin-top: 1px; }
    .status.ok { background: color-mix(in srgb, var(--pc-ok) 12%, var(--pc-bg)); } .status.ok .ico { color: var(--pc-ok); }
    .status.warn { background: color-mix(in srgb, var(--pc-warn) 12%, var(--pc-bg)); } .status.warn .ico { color: var(--pc-warn); }
    .status.err { background: color-mix(in srgb, var(--pc-err) 11%, var(--pc-bg)); } .status.err .ico { color: var(--pc-err); }
    .status a { color: inherit; font-weight: 650; text-decoration: underline; text-underline-offset: 2px; }

    /* list */
    .items { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .items li { padding: 12px 12px 10px; border: 1px solid var(--pc-line); border-radius: 14px; display: grid; gap: 7px; }
    .items .title { font-weight: 600; font-size: 14px; }
    .items .title a { color: var(--pc-muted); font-weight: 550; text-decoration: none; margin-right: 6px; font-variant-numeric: tabular-nums; }
    .items .title a:hover { color: var(--pc-accent); }
    .items .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--pc-muted); }
    .chip { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; background: var(--pc-surface); font-size: 11.5px; font-weight: 600; color: var(--pc-muted); }
    .items .reply { font-size: 13px; background: var(--pc-surface); border-radius: 12px 12px 12px 4px; padding: 8px 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .items .done { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; font-weight: 650; color: var(--pc-ok); }
    .items .done .ico { width: 15px; height: 15px; }
    .items li.closed .title { color: var(--pc-muted); }
    .items .goto { justify-self: start; height: 28px; padding: 0 10px 0 8px; margin-left: -8px; border: 0; background: none; color: var(--pc-muted); font-size: 12.5px; }
    .items .goto:hover { background: var(--pc-hover); color: var(--pc-ink); }
    .items .empty { border-style: dashed; text-align: center; color: var(--pc-muted); padding: 22px 12px; }

    /* marks: numbered frames on the page, the mark toolbar, the list in the panel */
    .marklayer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483644; }
    .mframe { position: fixed; border: 2px solid var(--pc-accent); border-radius: 6px; background: color-mix(in srgb, var(--pc-accent) 7%, transparent); }
    .mframe.box { border-style: dashed; }
    .mbadge { position: absolute; left: -11px; top: -11px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: var(--pc-accent);
      font: 700 12px/22px var(--pc-font); text-align: center; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
    .mbadge, .mbadge * { color: var(--pc-on-accent); }
    .boxcatch { position: fixed; inset: 0; z-index: 2147483645; cursor: crosshair; touch-action: none; }
    .marktools { position: fixed; left: 50%; bottom: calc(12px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 2147483647; display: grid; justify-items: center; gap: 6px; animation: pc-fade .2s; max-width: calc(100vw - 16px); }
    .marktools .bar { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 2px; padding: 6px; border-radius: 16px; background: var(--pc-bg); box-shadow: var(--pc-shadow); }
    .marktools .tip { order: -1; padding: 5px 12px; border-radius: 999px; background: var(--pc-ink); font-size: 12.5px; font-weight: 560; box-shadow: var(--pc-shadow); }
    .marktools .tip, .marktools .tip * { color: var(--pc-bg); }
    .marktools .tool .bubble { margin-left: 2px; }
    .marktools .tool:disabled { opacity: .35; }
    @media (max-width: 520px) {
      .marktools .tool[aria-pressed="false"] span:not(.ico):not(.bubble) { display: none; }
      .marktools .sep { display: none; }
      .marktools .done span:not(.ico):not(.bubble) { display: none; }
    }
    .marktools .bar { flex-wrap: nowrap; }
    .marklist .addnote { color: var(--pc-muted); }
    .marktools .tool.primary .bubble { background: var(--pc-on-accent); color: var(--pc-accent); }
    .marklist { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .marklist li { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 8px; border-radius: 12px; background: var(--pc-surface); }
    .marklist .num { flex: none; width: 22px; height: 22px; border-radius: 999px; background: var(--pc-accent); font: 700 12px/22px var(--pc-font); text-align: center; }
    .marklist .num { color: var(--pc-on-accent); }
    .marklist .what { flex: 1 1 40%; min-width: 0; display: grid; }
    .marklist .what b { font: 500 12.5px/1.3 var(--pc-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .marklist .what span { font-size: 12px; color: var(--pc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .marklist input { flex: 1 1 45%; min-width: 0; height: 32px; border: 1px solid var(--pc-line); border-radius: 9px; padding: 0 10px; background: var(--pc-bg); font-size: 13px; outline: 0; }
    .marklist input:focus { border-color: color-mix(in srgb, var(--pc-ink) 38%, transparent); }
    @media (max-width: 420px) { .marklist li { flex-wrap: wrap; } .marklist input { flex-basis: 100%; order: 3; } }

    /* picking */
    .box { position: fixed; pointer-events: none; z-index: 2147483645; border: 2px solid var(--pc-accent); border-radius: 6px;
      background: color-mix(in srgb, var(--pc-accent) 9%, transparent); transition: left .07s, top .07s, width .07s, height .07s; }
    .boxlabel { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; padding: 2px 7px; border-radius: 6px; background: var(--pc-accent);
      font: 11px/1.5 var(--pc-mono); white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
    .boxlabel, .boxlabel * { color: var(--pc-on-accent); }
    .box:not(.picking) .boxlabel { display: none; }
    .box.low .boxlabel { bottom: auto; top: 100%; margin: 4px 0 0; }
    .hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 12px;
      padding: 7px 7px 7px 16px; border-radius: 999px; background: var(--pc-ink); box-shadow: var(--pc-shadow); font-size: 13px; font-weight: 560; white-space: nowrap; animation: pc-fade .2s; }
    .hint, .hint * { color: var(--pc-bg); }
    .hint button { height: 30px; padding: 0 12px; border-radius: 999px; background: color-mix(in srgb, var(--pc-bg) 16%, transparent); font-size: 12.5px; font-weight: 600; }

    /* drawing sheet */
    .sheet { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px;
      overflow: auto; background: rgba(9,9,11,.88); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: pc-fade .2s; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px; padding: 6px; border-radius: 16px; background: var(--pc-bg); box-shadow: var(--pc-shadow); }
    .tool { height: 36px; padding: 0 11px; border-radius: 11px; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 560; color: var(--pc-muted); }
    .tool .ico { width: 17px; height: 17px; }
    .tool:hover { background: var(--pc-hover); color: var(--pc-ink); }
    .tool[aria-pressed="true"] { background: var(--pc-ink); color: var(--pc-bg); }
    .tool[aria-pressed="true"] * { color: var(--pc-bg); }
    .tool.primary { background: var(--pc-accent); color: var(--pc-on-accent); padding: 0 16px; }
    .tool.primary * { color: var(--pc-on-accent); }
    @media (max-width: 520px) {
      .tool.undo span:not(.ico), .tool.clear span:not(.ico) { display: none; }
      .tool { padding: 0 9px; } .sep { display: none; }
    }
    .sep { width: 1px; height: 22px; margin: 0 4px; background: var(--pc-line); }
    .sheet canvas { display: block; max-width: 100%; border-radius: 12px; box-shadow: 0 30px 80px -20px rgba(0,0,0,.7); touch-action: none; cursor: crosshair; background: #fff; }
    .pins { width: min(560px, 100%); display: grid; gap: 8px; }
    .pins label { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 12px; background: var(--pc-bg); }
    .pins .num { width: 24px; height: 24px; border-radius: 999px; background: #d13438; color: #fff; font-weight: 700; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .pins input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font-size: 14px; padding: 6px 4px; }

    /* success, shortcuts */
    .doneactions { display: flex; gap: 8px; }
    .doneactions button { flex: 1; height: 44px; border-radius: 12px; font-weight: 650; }
    .doneactions .another { background: var(--pc-ink); color: var(--pc-bg); }
    .doneactions .another * { color: var(--pc-bg); }
    .doneactions .shut { border: 1px solid var(--pc-line); }
    .shortcuts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12px; color: var(--pc-muted); }
    .shortcuts .kbd { padding: 3px 6px; }
    .shortcuts button { font-size: 12px; color: var(--pc-muted); text-decoration: underline; text-underline-offset: 2px; }
    .shortcuts button:hover { color: var(--pc-ink); }
    .body.voice > .speakwrap { order: -4; } .body.voice > .presets { order: -3; } .body.voice > .field { order: -2; } .body.voice > .kinds { order: -1; }

    /* fingers need room: 44 px targets on touch screens */
    @media (pointer: coarse) {
      .kinds button, .presets button, .fields .options button, .pill, .where .pill { min-height: 44px; }
      .mini, .iconbtn { width: 44px; height: 44px; }
      .tool { height: 44px; }
      button.send { height: 48px; }
      .tab { padding-left: 10px; padding-right: 10px; }
      .shortcuts button { min-height: 32px; }
    }

    @keyframes pc-in { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
    @keyframes pc-up { from { transform: translateY(100%); } to { transform: none; } }
    @keyframes pc-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pc-spin { to { transform: rotate(360deg); } }
    @keyframes pc-pulse { 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--pc-err) 25%, transparent); } }
    @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
    @media print { :host { display: none !important; } }
  `;

  // Icons: plain shapes on a 24 px grid, built with DOM calls so that a strict CSP allows them.
  const ICONS = {
    logo: [['rect', { x: 2.5, y: 8, width: 19, height: 8, rx: 4, transform: 'rotate(-45 12 12)' }], ['path', { d: 'M10.6 10.6h.01M13.4 13.4h.01M13.4 10.6h.01M10.6 13.4h.01' }]],
    pick: [['circle', { cx: 12, cy: 12, r: 7 }], ['path', { d: 'M12 2v4M12 18v4M2 12h4M18 12h4' }]],
    up: [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
    down: [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
    x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
    list: [['path', { d: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01' }]],
    back: [['path', { d: 'M19 12H5M11 18l-6-6 6-6' }]],
    image: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }], ['circle', { cx: 9, cy: 9, r: 2 }], ['path', { d: 'm21 15-5-5L5 21' }]],
    screen: [['rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2 }], ['path', { d: 'M8 21h8M12 17v4' }]],
    mic: [['rect', { x: 9, y: 2.5, width: 6, height: 12, rx: 3 }], ['path', { d: 'M5 10.5a7 7 0 0 0 14 0M12 17.5V21' }]],
    pen: [['path', { d: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }]],
    pin: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M10.5 9 12.5 8v8' }]],
    undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h11a5 5 0 0 1 0 10h-3' }]],
    trash: [['path', { d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14' }]],
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    alert: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 8v4.5M12 16h.01' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
    place: [['path', { d: 'M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z' }], ['circle', { cx: 12, cy: 10, r: 2.5 }]],
    frame: [['path', { d: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3' }]],
    reset: [['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }], ['path', { d: 'M3 3v5h5' }]],
    download: [['path', { d: 'M12 3v12M7 10l5 5 5-5M5 21h14' }]],
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const span = document.createElement('span');
    span.className = 'ico';
    span.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    for (const [tag, attrs] of ICONS[name] || []) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      svg.append(el);
    }
    span.append(svg);
    return span;
  }

  function createUi() {
    const els = {};
    // The marks: elements and regions of the page, numbered in this order.
    let marks = [];
    let tool = 'tap';
    let picking = false;
    const firstElement = () => (marks.find((m) => m.type === 'element') || {}).el || null;
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

    // A short name for an element: tag, then the id or the first class. The CSS path stays in the title.
    function nameOf(el) {
      const extra = el.id ? `#${el.id}` : el.classList[0] ? `.${el.classList[0]}` : '';
      return el.localName + extra;
    }
    function textOf(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function showBox(el) {
      if (!el) { els.box.hidden = true; return; }
      const r = el.getBoundingClientRect();
      // CSSOM properties, not a style attribute: a strict CSP allows this.
      Object.assign(els.box.style, { left: `${r.x - 2}px`, top: `${r.y - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      els.boxLabel.textContent = nameOf(el);
      els.box.classList.toggle('low', r.y < 30);
      els.box.hidden = false;
    }

    function markLabel(m) {
      if (m.type === 'box') return { name: t.region(Math.round(m.rect.w), Math.round(m.rect.h)), text: '' };
      const text = textOf(m.el);
      return { name: nameOf(m.el), text: text ? `“${text.slice(0, 60)}${text.length > 60 ? '…' : ''}”` : '' };
    }
    function clientRect(m) {
      if (m.type === 'box') return { x: m.rect.x - scrollX, y: m.rect.y - scrollY, w: m.rect.w, h: m.rect.h };
      const r = m.el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    // Frames and numbers on the page, in viewport coordinates, redrawn on scroll and resize.
    function drawFrames() {
      const show = marks.length && (!els.panel.hidden || picking);
      els.marklayer.hidden = !show;
      if (!show) { els.marklayer.replaceChildren(); return; }
      els.marklayer.replaceChildren(...marks.filter((m) => m.type === 'box' || m.el.isConnected).map((m) => {
        const r = clientRect(m);
        const f = h('div', { class: `mframe ${m.type}` }, h('span', { class: 'mbadge' }, String(marks.indexOf(m) + 1)));
        Object.assign(f.style, { left: `${r.x - 3}px`, top: `${r.y - 3}px`, width: `${r.w + 6}px`, height: `${r.h + 6}px` });
        return f;
      }));
    }
    let frameQueued = false;
    const queueFrames = () => { if (!frameQueued) { frameQueued = true; requestAnimationFrame(() => { frameQueued = false; drawFrames(); }); } };
    addEventListener('scroll', queueFrames, { passive: true, capture: true });
    addEventListener('resize', queueFrames);

    function renderMarks() {
      els.where.hidden = !marks.length;
      els.marklist.replaceChildren(...marks.map((m, i) => {
        const { name, text } = markLabel(m);
        // The note field opens on demand, so that a list of marks stays short on a phone.
        const note = h('input', { type: 'text', maxlength: '200', placeholder: t.note, 'aria-label': `${t.note} ${i + 1}` });
        note.value = m.note || '';
        note.hidden = !m.note && !m.noteOpen;
        note.addEventListener('input', () => { m.note = note.value; });
        const add = iconBtn('addnote mini', 'pen', t.note, () => { m.noteOpen = true; note.hidden = false; add.hidden = true; note.focus(); });
        add.hidden = !note.hidden;
        return h('li', { 'data-mark': String(i + 1), title: m.type === 'element' ? cssPath(m.el) : '' },
          h('span', { class: 'num' }, String(i + 1)),
          h('div', { class: 'what' }, h('b', {}, name), ...(text ? [h('span', {}, text)] : [])),
          note, add,
          iconBtn('remove-mark mini', 'x', t.removeMark(i + 1), () => { marks.splice(i, 1); renderMarks(); }));
      }));
      const last = marks[marks.length - 1];
      const el = last && last.type === 'element' ? last.el : null;
      els.parent.disabled = !el || !el.parentElement || el.parentElement === document.documentElement || el.parentElement === document.body;
      els.child.disabled = !(last && last.chain && last.chain.length);
      // Larger and Smaller show only when the newest mark is an element.
      els.parent.hidden = els.child.hidden = !el;
      els.markCount.textContent = marks.length ? String(marks.length) : '';
      els.markPic.hidden = !marks.some((m) => m.type === 'element' && imageIn(m.el));
      drawFrames();
    }
    function toggleElement(el) {
      const i = marks.findIndex((m) => m.type === 'element' && m.el === el);
      if (i >= 0) marks.splice(i, 1);
      else if (marks.length < 10) marks.push({ type: 'element', el, note: '', chain: [] });
      renderMarks();
    }
    // Larger and Smaller move the newest element mark up to its parent and back down.
    function larger() {
      const m = marks[marks.length - 1];
      if (!m || m.type !== 'element' || !m.el.parentElement) return;
      m.chain.push(m.el);
      m.el = m.el.parentElement;
      renderMarks();
    }
    function smaller() {
      const m = marks[marks.length - 1];
      if (!m || !m.chain || !m.chain.length) return;
      m.el = m.chain.pop();
      renderMarks();
    }
    function clearMarks() { marks = []; renderMarks(); }

    const pointAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el !== host && el !== document.documentElement && el !== document.body ? el : null;
    };
    const onMove = (e) => { const el = pointAt(e); if (el) showBox(el); };
    const onPick = (e) => {
      const el = pointAt(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      if (tool === 'draw') {
        const img = imageIn(el);
        if (!img) { els.markTip.textContent = t.hintDraw; return; }
        stopPicking();
        markPicture(img);
        return;
      }
      toggleElement(el);
      showBox(el);
    };
    const swallow = (e) => { if (e.target !== host) { e.preventDefault(); e.stopPropagation(); } };
    // Inside a modal dialog, Esc is also a close request for the dialog. In mark mode it only ends the marking.
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopPicking(); } };
    const PICK_EVENTS = [['pointermove', onMove], ['click', onPick], ['pointerdown', swallow], ['mousedown', swallow], ['keydown', onKey]];

    // Box tool: drag a region on the page. It is stored in page coordinates, so it stays put when the page scrolls.
    let drag = null;
    function boxDown(e) {
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY };
      els.boxcatch.setPointerCapture(e.pointerId);
      els.boxPreview.hidden = false;
      Object.assign(els.boxPreview.style, { left: `${drag.x}px`, top: `${drag.y}px`, width: '0px', height: '0px' });
    }
    function boxMove(e) {
      if (!drag) return;
      Object.assign(els.boxPreview.style, { left: `${Math.min(drag.x, e.clientX)}px`, top: `${Math.min(drag.y, e.clientY)}px`,
        width: `${Math.abs(e.clientX - drag.x)}px`, height: `${Math.abs(e.clientY - drag.y)}px` });
    }
    function boxUp(e) {
      if (!drag) return;
      const r = { x: Math.min(drag.x, e.clientX) + scrollX, y: Math.min(drag.y, e.clientY) + scrollY, w: Math.abs(e.clientX - drag.x), h: Math.abs(e.clientY - drag.y) };
      drag = null;
      els.boxPreview.hidden = true;
      if (r.w >= 8 && r.h >= 8 && marks.length < 10) { marks.push({ type: 'box', rect: r, note: '' }); renderMarks(); }
    }

    function setMarkTool(next) {
      tool = next;
      for (const [k, b] of Object.entries({ tap: els.toolTap, box: els.toolBox, draw: els.toolDraw })) b.setAttribute('aria-pressed', String(k === next));
      els.markTip.textContent = { tap: t.hintTap, box: t.hintBox, draw: t.hintDraw }[next];
      els.boxcatch.hidden = next !== 'box';
      els.box.hidden = true;
    }

    function startPicking() {
      picking = true;
      els.box.classList.add('picking');
      els.panel.hidden = true;
      els.scrim.hidden = true;
      els.marktools.hidden = false;
      setMarkTool(tool);
      for (const [type, fn] of PICK_EVENTS) addEventListener(type, fn, true);
      drawFrames();
    }
    function stopPicking() {
      if (!picking) return;
      picking = false;
      els.box.classList.remove('picking');
      els.box.hidden = true;
      els.boxcatch.hidden = true;
      els.marktools.hidden = true;
      els.panel.hidden = false;
      els.scrim.hidden = false;
      for (const [type, fn] of PICK_EVENTS) removeEventListener(type, fn, true);
      renderMarks();
    }

    const isHidden = () => { try { return typeof window.papercutsHidden === 'function' && !!window.papercutsHidden(); } catch (_) { return false; } };

    // A modal <dialog> sits in the top layer and makes the rest of the page inert. Inside it, the widget stays usable.
    function home() {
      const modal = [...document.querySelectorAll('dialog[open]')].filter((d) => { try { return d.matches(':modal'); } catch (_) { return false; } }).pop();
      if (modal) return modal;
      // In fullscreen the browser shows only one element. A video, canvas or picture cannot hold the widget.
      const full = document.fullscreenElement;
      if (full && !/^(video|canvas|img|iframe|svg)$/i.test(full.localName)) return full;
      return document.documentElement;
    }
    function rehome() {
      const target = home();
      if (host.parentNode !== target) target.append(host);
    }

    // The element that the person touched last, shortly before opening, is what the feedback is about.
    let lastTap = null;
    addEventListener('pointerdown', (e) => {
      if (picking || e.composedPath().includes(host)) return;
      if (e.target && e.target.nodeType === 1 && e.target !== document.documentElement && e.target !== document.body) lastTap = { el: e.target, at: Date.now() };
    }, true);

    function open() {
      if (isHidden()) return;
      if (!marks.length && lastTap && Date.now() - lastTap.at < 15000 && lastTap.el.isConnected) { marks.push({ type: 'element', el: lastTap.el, note: '', chain: [] }); lastTap = null; }
      rehome();
      if (doneState) showForm();
      els.panel.hidden = false;
      els.scrim.hidden = false;
      els.tab.classList.add('away');
      els.tab.inert = true;
      els.tab.setAttribute('aria-expanded', 'true');
      renderMarks();
      // On a phone the keyboard would cover half the sheet before the user decides anything, so focus the heading.
      if (els.form.hidden) return;
      if (matchMedia('(pointer: coarse)').matches) els.heading.focus({ preventScroll: true });
      else els.text.focus({ preventScroll: true });
    }
    function close() {
      stopPicking();
      const hadFocus = host.shadowRoot.activeElement != null;
      els.panel.hidden = true;
      els.scrim.hidden = true;
      els.box.hidden = true;
      els.marklayer.hidden = true;
      els.tab.classList.remove('away');
      els.tab.inert = false;
      els.tab.setAttribute('aria-expanded', 'false');
      clearTimeout(autoClose);
      if (hadFocus) els.tab.focus({ preventScroll: true });
    }
    const toggle = () => (els.panel.hidden ? open() : close());

    // ---- drawing sheet: a picture with pen strokes and numbered pins ----
    let mark = null; // { shot, pins } after "Done"
    const sheet = { marks: [], tool: 'pen', img: null, canvas: null, ctx: null, drawing: null };

    function lineWidth() { return Math.max(3, Math.round(Math.max(sheet.canvas.width, sheet.canvas.height) / 220)); }
    function redraw() {
      const { ctx, canvas } = sheet;
      ctx.drawImage(sheet.img, 0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#d13438'; ctx.lineWidth = lineWidth();
      let nr = 0;
      for (const m of sheet.marks) {
        if (m.type === 'pen') {
          ctx.beginPath();
          m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        } else {
          nr++;
          const r = lineWidth() * 3;
          ctx.fillStyle = '#d13438'; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(nr), m.x, m.y);
        }
      }
    }
    function renderPins() {
      els.pins.replaceChildren(...sheet.marks.filter((m) => m.type === 'pin').map((m, i) => {
        const input = h('input', { type: 'text', maxlength: '120', placeholder: t.pinText, 'aria-label': t.pinLabel(i + 1) });
        input.value = m.text;
        input.addEventListener('input', () => { m.text = input.value; });
        return h('label', {}, h('span', { class: 'num' }, String(i + 1)), input);
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
      const fit = Math.min((innerWidth - 32) / canvas.width, (innerHeight - 240) / canvas.height, 4);
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
      els.scrim.hidden = true;
      els.box.hidden = true;
      els.sheet.hidden = false;
    }
    function closeSheet() {
      els.sheet.hidden = true;
      els.panel.hidden = false;
      els.scrim.hidden = false;
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
      els.shotMeta.textContent = pins.length ? t.pins(pins.length) : '';
      els.previewRow.hidden = false;
      closeSheet();
    }
    function forgetMark() {
      mark = null;
      els.preview.removeAttribute('src');
      els.previewRow.hidden = true;
    }
    function imageIn(el) {
      if (!el) return null;
      return el.localName === 'img' ? el : el.querySelector && el.querySelector('img');
    }
    function markPicture(target) {
      const src = target && target.localName === 'img' ? target : (marks.map((m) => m.type === 'element' && imageIn(m.el)).find(Boolean) || null);
      if (!src) return;
      // Load it again with CORS. A picture from another site without CORS would taint the canvas.
      const copy = new Image();
      copy.crossOrigin = 'anonymous';
      copy.onload = () => openSheet(copy);
      copy.onerror = () => setStatus('warn', t.cannotMark);
      copy.src = src.currentSrc || src.src;
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
        setStatus('warn', t.noScreen + ((e && (e.message || e.name)) || 'cancelled'));
      }
    }

    // ---- voice input ----
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    let listening = null;
    function toggleMic() {
      if (listening) { listening.stop(); return; }
      const rec = new Speech();
      // data-speech-lang, else the language of the page, for example "de-DE".
      rec.lang = cfg.speechLang || cfg.lang || (repoCfg && repoCfg.lang) || document.documentElement.lang || 'en-US';
      rec.interimResults = true;
      const base = els.text.value.trim();
      // On a phone, speech stops by itself after a pause: open, speak, send is three taps.
      // It also avoids repeated final words of continuous mode in Android Chrome.
      rec.continuous = !matchMedia('(pointer: coarse)').matches;
      // Words show live while the person speaks. The final words replace the live ones.
      let done = '';
      rec.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const said = e.results[i][0].transcript.trim();
          if (e.results[i].isFinal) done = `${done} ${said}`.trim();
          else live = `${live} ${said}`.trim();
        }
        els.text.value = [base, done, live].filter(Boolean).join(' ').slice(0, 300);
        textChanged();
      };
      rec.onend = () => {
        listening = null;
        els.mic.setAttribute('aria-pressed', 'false'); els.mic.setAttribute('aria-label', t.mic); els.mic.title = t.mic;
        els.speak.setAttribute('aria-pressed', 'false'); els.speakLabel.textContent = t.speak;
      };
      const MIC_ERRORS = { 'not-allowed': t.micBlocked, 'service-not-allowed': t.micBlocked, 'no-speech': t.noSpeech, network: t.micNetwork, 'audio-capture': t.micBlocked };
      rec.onerror = (e) => { if (e.error !== 'aborted') setStatus('warn', MIC_ERRORS[e.error] || t.micFailed); };
      listening = rec;
      els.mic.setAttribute('aria-pressed', 'true');
      els.mic.setAttribute('aria-label', t.micStop);
      els.mic.title = t.micStop;
      els.speak.setAttribute('aria-pressed', 'true');
      els.speakLabel.textContent = t.listening;
      rec.start();
    }

    // ---- list of open papercuts ----
    let items = [];
    const listText = () => { const f = items.filter((i) => i.state === 'closed').length; return t.list(items.length - f, f); };
    const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (_) { return {}; } };
    const unseen = () => { const s = seen(); return items.filter((i) => i.replyCount > (s[i.issue] || 0)).length; };
    function markSeen() {
      const s = seen();
      for (const i of items) s[i.issue] = i.replyCount;
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (_) { /* no badge memory */ }
      els.replies.textContent = '';
      els.listDot.hidden = true;
      els.listBtn.title = '';
    }
    async function loadList() {
      if (!cfg.repo) return;
      try {
        const res = await fetch(`${relay}/list?repo=${encodeURIComponent(cfg.repo)}`, { credentials: 'include', redirect: 'manual' });
        const data = res.ok ? await res.json() : null;
        if (!data || !data.ok) { els.listBtn.hidden = true; return; }
        items = data.items || [];
      } catch (_) { els.listBtn.hidden = true; return; }
      // No list button while there is nothing to list, unless the list is open now.
      els.listBtn.hidden = !items.length && els.listView.hidden;
      if (els.listView.hidden) els.listLabel.textContent = listText();
      const n = unseen();
      els.replies.textContent = n ? String(n) : '';
      els.listDot.hidden = !n;
      els.listBtn.title = n ? t.replies(n).replace(/^ · /, '') : '';
      els.tab.setAttribute('aria-label', t.tabTitle + (n ? t.replies(n) : ''));
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
        const closed = i.state === 'closed';
        return h('li', { 'data-issue': String(i.issue), ...(closed ? { class: 'closed' } : {}) },
          ...(closed ? [h('div', { class: 'done' }, icon('check'), `${t.fixed}${i.fix ? `: ${i.fix}` : ''}`)] : []),
          h('div', { class: 'title' }, h('a', { href: i.url, target: '_blank', rel: 'noopener' }, `#${i.issue}`), i.title),
          h('div', { class: 'meta' }, h('span', { class: 'chip' }, t.kinds[i.kind] || i.kind),
            `${t.age(days(i.created))} · ${t.replyCount(i.replyCount)}${i.plus ? ` · +${i.plus}` : ''}`),
          ...(last && !(closed && /^Fixed: /.test(last.text)) ? [h('div', { class: 'reply' }, last.text)] : []),
          ...(i.place && /^https?:\/\//i.test(i.place.url || '') && !closed
            ? [h('button', { type: 'button', class: 'goto pill', onclick: () => goTo(i.place) }, icon('place'), t.goto)] : []));
      }) : [h('li', { class: 'empty' }, t.empty)]));
    }
    function showList(on) {
      els.listView.hidden = !on;
      els.form.hidden = on;
      els.foot.hidden = on;
      els.listLabel.textContent = on ? t.back : listText();
      els.listBtn.replaceChild(icon(on ? 'back' : 'list'), els.listBtn.firstChild);
      if (on) { renderList(); markSeen(); } else els.text.focus({ preventScroll: true });
    }

    // ---- form helpers ----
    // No kind is chosen at first: a report without a choice is filed as "other", not as a wrong "bug".
    let kind = null;
    let draftFields = null;
    // The kind is for agents. People do not choose it: a preset or a draft can set it, else it is "other".
    function setKind(k) { kind = k; }
    function textChanged() {
      const n = els.text.value.length;
      els.counter.textContent = n >= 200 ? `${n} / 300` : '';
      els.counter.classList.toggle('near', n >= 270);
      // Grow with the text, up to the max height in the CSS.
      els.text.style.height = 'auto';
      els.text.style.height = `${els.text.scrollHeight}px`;
    }
    const STATUS_ICON = { ok: 'check', warn: 'clock', err: 'alert', info: 'clock' };
    function setStatus(kindOf, ...content) {
      els.status.className = `status ${kindOf || ''}`;
      els.status.replaceChildren(...(content.length ? [icon(STATUS_ICON[kindOf] || 'alert'), h('div', {}, ...content)] : []));
    }

    // After a send: a thank-you with "Report another" and "Close", no second send by accident.
    let doneState = false;
    let autoClose = null;
    function showDone() {
      doneState = true;
      els.form.hidden = true;
      els.sendrow.hidden = true;
      els.doneRow.hidden = false;
      els.another.focus({ preventScroll: true });
      if (matchMedia('(pointer: coarse)').matches) autoClose = setTimeout(close, 2500);
    }
    function showForm() {
      doneState = false;
      clearTimeout(autoClose);
      els.form.hidden = false;
      els.sendrow.hidden = false;
      els.doneRow.hidden = true;
      setStatus();
    }

    // A new feedback starts clean: no text, no picture, no element, no draft kind or fields.
    const clearForm = () => { els.text.value = ''; textChanged(); forgetMark(); clearMarks(); kind = null; draftFields = null; };

    function marksPayload() {
      if (!marks.length) return {};
      return {
        marks: marks.map((m, i) => {
          const base = { nr: i + 1, type: m.type, note: m.note || '' };
          if (m.type === 'box') return { ...base, rect: m.rect };
          const r = m.el.getBoundingClientRect();
          return { ...base, name: nameOf(m.el), text: textOf(m.el).slice(0, 120), selector: cssPath(m.el), rect: { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height } };
        }),
        placeMarks: marks.map((m) => (m.type === 'box' ? { box: m.rect } : { selector: cssPath(m.el) })),
      };
    }

    async function submit() {
      const text = els.text.value.trim();
      if (!text) { setStatus('warn', t.writeFirst); els.text.focus(); return; }
      // People give feedback only. Agents triage it: no kind means "other", fields come only from a draft.
      const input = { kind: kind || 'other', text, from: 'human', ...(mark || {}), ...(draftFields ? { fields: draftFields } : {}), ...marksPayload() };
      if (DOWNLOAD) {
        downloadReport(input, firstElement());
        clearForm();
        setStatus('ok', t.downloaded);
        return;
      }
      els.send.disabled = true;
      els.send.classList.add('busy');
      setStatus('info', t.sending);
      const r = await window.papercuts.report({ ...input, _el: firstElement() });
      els.send.disabled = false;
      els.send.classList.remove('busy');
      if (r.ok) {
        setStatus('ok', t.thanks, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, `#${r.issue}`));
        clearForm();
        showDone();
      } else if (r.queued) {
        setStatus('warn', /log in/.test(r.error) ? t.savedLogin : t.saved);
      } else {
        setStatus('err', `${t.notSent}${r.error}. ${r.help || ''}`);
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
    const ACCENT = cfg.accent && window.CSS && CSS.supports('color', cfg.accent) ? cfg.accent : '';
    if (ACCENT) host.style.setProperty('--pc-accent', ACCENT);
    const iconBtn = (cls, name, label, onclick, extra = {}) => h('button', { type: 'button', class: cls, 'aria-label': label, title: label, onclick, ...extra }, icon(name));

    els.count = h('span', { class: 'bubble count' });
    els.replies = h('span', { class: 'bubble replies' });
    els.tab = h('button', { class: 'tab', type: 'button', title: t.tabTitle, 'aria-label': t.tabTitle, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      icon('logo'), h('span', { class: 'label' }, t.tab), els.count, els.replies);
    makeDraggable(els.tab);

    els.parent = h('button', { type: 'button', class: 'tool parent', 'aria-label': t.parent, title: t.parent, onclick: larger }, icon('up'));
    els.child = h('button', { type: 'button', class: 'tool child', 'aria-label': t.child, title: t.child, disabled: '', onclick: smaller }, icon('down'));
    els.pick = h('button', { type: 'button', class: 'pick pill', onclick: startPicking }, icon('pick'), t.pick);


    els.text = h('textarea', { maxlength: '300', rows: '3', placeholder: t.placeholder, 'aria-label': t.title });
    els.counter = h('span', { class: 'counter', 'aria-live': 'polite' });
    els.text.addEventListener('input', textChanged);
    els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
    els.mic = iconBtn('mic iconbtn', 'mic', t.mic, toggleMic, { 'aria-pressed': 'false' });
    els.mic.hidden = !Speech;
    // Voice first on a phone: a large button leads the sheet. data-voice="off" turns it off.
    const VOICE_FIRST = !!Speech && cfg.voice !== 'off' && matchMedia('(pointer: coarse)').matches;
    els.speak = h('button', { type: 'button', class: 'speak', 'aria-pressed': 'false', 'aria-label': t.speak, onclick: toggleMic }, icon('mic'));
    els.speakLabel = h('div', { class: 'hint2' }, t.speak);
    els.speakWrap = h('div', { class: 'speakwrap' }, els.speak, els.speakLabel, h('div', { class: 'hint3' }, t.typeInstead));
    els.speakWrap.hidden = !VOICE_FIRST;
    if (VOICE_FIRST) els.mic.hidden = true;

    els.presets = h('div', { class: 'presets' }, ...presetList().map((p) => h('button', { type: 'button', onclick: () => { setKind(kindsList().includes(p.kind) ? p.kind : kind); els.text.value = p.text; textChanged(); if (!matchMedia('(pointer: coarse)').matches) els.text.focus(); } }, p.text)));
    els.presets.hidden = !presetList().length;

    els.markPic = h('button', { type: 'button', class: 'mark-pic pill', hidden: '', onclick: () => markPicture() }, icon('image'), t.markPic);
    els.markScreen = h('button', { type: 'button', class: 'mark-screen pill', onclick: markScreen }, icon('screen'), t.markScreen);
    els.markScreen.hidden = !canCapture();
    els.preview = h('img', { class: 'preview', alt: t.picture });
    els.shotMeta = h('span', {});
    els.previewRow = h('div', { class: 'shot', hidden: '' }, els.preview,
      h('div', { class: 'meta' }, h('strong', {}, t.picture), els.shotMeta),
      iconBtn('remove-pic mini', 'x', t.removePic, forgetMark));

    els.send = h('button', { type: 'button', class: 'send', onclick: submit }, DOWNLOAD ? t.download : t.send);
    els.status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

    els.toolPen = h('button', { type: 'button', class: 'tool tool-pen', onclick: () => setTool('pen') }, icon('pen'), t.pen);
    els.toolPin = h('button', { type: 'button', class: 'tool tool-pin', onclick: () => setTool('pin') }, icon('pin'), t.pin);
    els.canvasSlot = h('div', {});
    els.pins = h('div', { class: 'pins' });
    els.sheet = h('div', { class: 'sheet', hidden: '', role: 'dialog', 'aria-label': t.markPic },
      h('div', { class: 'toolbar' }, els.toolPen, els.toolPin, h('span', { class: 'sep' }),
        h('button', { type: 'button', class: 'tool undo', 'aria-label': t.undo, title: t.undo, onclick: () => { sheet.marks.pop(); renderPins(); redraw(); } }, icon('undo'), h('span', {}, t.undo)),
        h('button', { type: 'button', class: 'tool clear', 'aria-label': t.clear, title: t.clear, onclick: () => { sheet.marks = []; renderPins(); redraw(); } }, icon('trash'), h('span', {}, t.clear)),
        h('span', { class: 'sep' }),
        h('button', { type: 'button', class: 'tool cancel', onclick: closeSheet }, t.cancel),
        h('button', { type: 'button', class: 'tool done primary', onclick: finishSheet }, icon('check'), t.done)),
      els.canvasSlot, els.pins);

    els.listLabel = h('span', {}, t.list(0));
    els.listDot = h('span', { class: 'dot', hidden: '' });
    els.listBtn = h('button', { type: 'button', class: 'list pill', hidden: '', onclick: () => showList(els.listView.hidden) }, icon('list'), els.listLabel, els.listDot);
    els.items = h('ul', { class: 'items' });
    els.listView = h('div', { hidden: '' }, els.items);
    // One input. The element, the place, the errors and the page state come along in the background.
    els.marklist = h('ol', { class: 'marklist' });
    els.where = h('div', { class: 'marks', hidden: '' }, els.marklist);
    els.toolTap = h('button', { type: 'button', class: 'tool tool-tap', onclick: () => setMarkTool('tap') }, icon('pick'), h('span', {}, t.toolTap));
    els.toolBox = h('button', { type: 'button', class: 'tool tool-box', onclick: () => setMarkTool('box') }, icon('frame'), h('span', {}, t.toolBox));
    els.toolDraw = h('button', { type: 'button', class: 'tool tool-draw', onclick: () => setMarkTool('draw') }, icon('pen'), h('span', {}, t.toolDraw));
    els.markCount = h('span', { class: 'bubble' });
    els.markTip = h('div', { class: 'tip', role: 'status' });
    els.marktools = h('div', { class: 'marktools', hidden: '' },
      h('div', { class: 'bar', role: 'toolbar', 'aria-label': t.pick }, els.toolTap, els.toolBox, els.toolDraw, h('span', { class: 'sep' }), els.parent, els.child,
        h('span', { class: 'sep' }), h('button', { type: 'button', class: 'tool done primary', 'aria-label': t.markDone, onclick: () => stopPicking() }, icon('check'), h('span', {}, t.markDone), els.markCount)),
      els.markTip);
    els.marklayer = h('div', { class: 'marklayer', hidden: '' });
    els.boxPreview = h('div', { class: 'mframe box', hidden: '' });
    els.boxcatch = h('div', { class: 'boxcatch', hidden: '' }, els.boxPreview);
    els.boxcatch.addEventListener('pointerdown', boxDown);
    els.boxcatch.addEventListener('pointermove', boxMove);
    els.boxcatch.addEventListener('pointerup', boxUp);
    els.boxcatch.addEventListener('pointercancel', () => { drag = null; els.boxPreview.hidden = true; });
    els.form = h('div', { class: 'body form-area' },
      els.speakWrap,
      els.presets,
      h('div', { class: 'field' }, els.text, h('div', { class: 'fieldbar' }, els.mic, els.counter)),
      els.where,
      h('div', { class: 'attach' }, els.pick, els.markPic, els.markScreen),
      els.previewRow);
    if (VOICE_FIRST) els.form.classList.add('voice');
    els.listView.className = 'body';
    els.sendrow = h('div', { class: 'sendrow' }, els.send, ...(DOWNLOAD ? [] : [h('span', { class: 'kbd', 'aria-hidden': 'true' }, mac ? '⌘ ↵' : 'Ctrl ↵')]));
    els.another = h('button', { type: 'button', class: 'another', onclick: () => { showForm(); if (!matchMedia('(pointer: coarse)').matches) els.text.focus(); } }, t.another);
    els.doneRow = h('div', { class: 'doneactions', hidden: '' }, els.another, h('button', { type: 'button', class: 'shut', onclick: () => close() }, t.close));
    els.copyLink = h('button', { type: 'button', class: 'copylink', onclick: async () => {
      const link = `${location.href.split('#')[0]}#papercut`;
      try { await navigator.clipboard.writeText(link); els.copyLink.textContent = t.copied; } catch (_) { prompt(t.copyLink, link); }
      setTimeout(() => { els.copyLink.textContent = t.copyLink; }, 2000);
    } }, t.copyLink);
    els.shortcutKeys = h('span', { class: 'kbd' });
    els.shortcuts = h('div', { class: 'shortcuts' }, els.shortcutKeys,
      ...(matchMedia('(pointer: coarse)').matches && cfg.gesture !== 'off' ? [h('span', {}, t.twoFingers)] : []), els.copyLink);
    els.foot = h('div', { class: 'foot' }, els.status, els.sendrow, els.doneRow, ...(DOWNLOAD ? [] : [els.shortcuts]));
    els.panel = h('div', { class: 'panel', hidden: '', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.title },
      h('div', { class: 'grab', 'aria-hidden': 'true' }),
      h('div', { class: 'head' }, (els.heading = h('h2', { tabindex: '-1' }, icon('logo'), t.title)), els.listBtn, iconBtn('close iconbtn', 'x', t.close, () => close())),
      els.form, els.listView, els.foot);
    // Esc closes the panel. Inside a modal dialog it must not close the dialog too.
    // Keep Tab inside the open panel.
    els.panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const all = [...els.panel.querySelectorAll('button, textarea, input, a[href], [tabindex]')]
        .filter((x) => !x.disabled && x.tabIndex >= 0 && x.getClientRects().length);
      if (!all.length) return;
      const now = host.shadowRoot.activeElement;
      const i = all.indexOf(now);
      if (e.shiftKey && i <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === all.length - 1)) { e.preventDefault(); all[0].focus(); }
    });
    // Esc closes the sheet, the picking or the panel, from anywhere on the page. In a modal dialog of the page,
    // the capture phase and preventDefault keep the dialog open.
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || picking) return;
      if (!els.sheet.hidden) { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
      if (!els.panel.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    }, true);
    els.scrim = h('div', { class: 'scrim', hidden: '', onclick: () => close() });
    els.boxLabel = h('span', { class: 'boxlabel' });
    els.box = h('div', { class: 'box', hidden: '' }, els.boxLabel);
    shadow.append(els.marklayer, els.box, els.boxcatch, els.marktools, els.tab, els.scrim, els.panel, els.sheet);
    setKind(null);
    document.documentElement.append(host);
    renderMarks();
    els.box.hidden = true;
    // data-shortcut="alt+shift+p" (default) or "off". Matched on the physical key, so it works on every keyboard layout.
    const combo = (cfg.shortcut || 'alt+shift+p').toLowerCase();
    if (combo !== 'off') {
      const parts = combo.split(/[+\s]+/).filter(Boolean);
      const key = parts.pop();
      const want = { alt: parts.includes('alt'), shift: parts.includes('shift'), ctrl: parts.includes('ctrl'), meta: parts.includes('meta') || parts.includes('cmd') };
      const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : null;
      addEventListener('keydown', (e) => {
        if (e.altKey !== want.alt || e.shiftKey !== want.shift || e.ctrlKey !== want.ctrl || e.metaKey !== want.meta) return;
        if (code ? e.code !== code : e.key.toLowerCase() !== key) return;
        e.preventDefault();
        toggle();
      }, true);
      const label = combo.split(/[+\s]+/).filter(Boolean).map((x) => (x.length === 1 ? x.toUpperCase() : x[0].toUpperCase() + x.slice(1))).join('+');
      const plain = t.tabTitle.replace(/ \(.*\)$/, '');
      els.tab.title = `${plain} (${label})`;
      els.tab.setAttribute('aria-label', `${plain} (${label})`);
      els.tab.setAttribute('aria-keyshortcuts', label);
      els.shortcutKeys.textContent = label;
    } else {
      els.shortcutKeys.hidden = true;
    }
    // A long press with two fingers opens the panel on a touch screen. data-gesture="off" turns it off.
    if (cfg.gesture !== 'off') {
      let timer = null;
      let startPts = null;
      const cancel = () => { clearTimeout(timer); timer = null; };
      addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) { cancel(); return; }
        startPts = [...e.touches].map((p) => [p.clientX, p.clientY]);
        cancel();
        timer = setTimeout(() => { timer = null; if (els.panel.hidden && !isHidden()) open(); }, 600);
      }, { passive: true, capture: true });
      addEventListener('touchmove', (e) => {
        if (!timer || !startPts) return;
        const moved = [...e.touches].some((p, i) => startPts[i] && Math.hypot(p.clientX - startPts[i][0], p.clientY - startPts[i][1]) > 12);
        if (moved) cancel();
      }, { passive: true, capture: true });
      addEventListener('touchend', cancel, { passive: true, capture: true });
      addEventListener('touchcancel', cancel, { passive: true, capture: true });
    }
    // A link with #papercut or ?papercut=open opens the panel: for bookmarks, QR codes and home-screen links.
    const params = new URLSearchParams(location.search);
    if (location.hash === '#papercut' || params.get('papercut') === 'open') {
      params.delete('papercut');
      const q = params.toString();
      history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + (location.hash === '#papercut' ? '' : location.hash));
      setTimeout(open, 0);
    }
    document.addEventListener('fullscreenchange', rehome);
    new MutationObserver(rehome).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    // The page decides when the widget hides, for example in a print or kids view.
    const applyHidden = () => {
      const hide = isHidden();
      els.tab.hidden = hide;
      if (hide && (!els.panel.hidden || picking)) close();
    };
    applyHidden();
    setInterval(applyHidden, 1000);
    if (!DOWNLOAD) {
      loadList();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadList(); });
    }

    return {
      open(draft) {
        if (draft && typeof draft === 'object') {
          if (draft.kind && kindsList().includes(draft.kind)) setKind(draft.kind);
          if (typeof draft.text === 'string') { els.text.value = draft.text.slice(0, 300); textChanged(); }
          if (draft.fields && typeof draft.fields === 'object') draftFields = { ...draft.fields };
          // marks: elements or CSS selectors that the feedback is about. Unknown selectors are left out.
          if (Array.isArray(draft.marks)) {
            marks = [];
            for (const m of draft.marks.slice(0, 10)) {
              let el = null;
              try { el = typeof m === 'string' ? document.querySelector(m) : m; } catch (_) { el = null; }
              if (el && el.nodeType === 1) marks.push({ type: 'element', el, note: '', chain: [] });
            }
          }
        }
        open();
      },
      async badge() {
        const n = (await queued()).length;
        els.count.textContent = n ? String(n) : '';
        els.count.title = n ? t.waiting(n).replace(/^ · /, '') : '';
      },
      notice(text, href, label) {
        if (href) setStatus('warn', text, h('a', { href, target: '_blank', rel: 'noopener' }, label || href));
        else setStatus('warn', text);
      },
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
    // open({ kind, text, fields }) opens the panel with a draft, for an app's own button or menu entry.
    open: (draft) => ui.open(draft),
  };

  async function loadRepoConfig() {
    if (!cfg.repo) return null;
    try {
      const res = await fetch(`${relay}/config?repo=${encodeURIComponent(cfg.repo)}`, { credentials: 'include', redirect: 'manual' });
      const data = res.ok ? await res.json() : null;
      if (data && data.warnings && data.warnings.length) console.warn('papercuts: .github/papercuts.json:', data.warnings.join('; '));
      return data && data.ok ? data.config : null;
    } catch (_) { return null; }
  }

  async function start() {
    t = strings();
    if (DOWNLOAD) { ui = createUi(); return; }
    const s = await status();
    if (s.login) {
      // The login of the relay ended. Show the tab, explain, and keep reports in the queue until the login is back.
      ui = createUi();
      ui.notice(t.loginFirst, `${relay}/status`, t.loginLink);
      ui.badge();
      return;
    }
    if (!s.reachable) {
      console.warn(`papercuts: relay ${relay} not reachable (${s.reason}), widget hidden`);
      return;
    }
    repoCfg = await loadRepoConfig();
    t = strings();
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
