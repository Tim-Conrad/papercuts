// Device viewer: the app at phone, tablet, desktop and TV size side by side, on one page.
// Owned by the app template (nix/dev-viewer.ts is the same file, for custom sites). Served at
// /dev.html only with DEV_TOOLS=1, which every preview sets. The frames show the same origin,
// so navigation in one frame can follow in the others ("Sync"). No framework, no Tailwind: it
// must work in every app.

import { APP_VERSION } from "../version";

type Device = { id: string; label: string; w: number; h: number };

const DEVICES: Device[] = [
  { id: "phone", label: "Phone", w: 390, h: 844 },
  { id: "phone-land", label: "Phone landscape", w: 844, h: 390 },
  { id: "tablet", label: "Tablet", w: 820, h: 1180 },
  { id: "desktop", label: "Desktop", w: 1280, h: 800 },
  { id: "tv", label: "TV", w: 1920, h: 1080 },
];
const GAP = 24;
const STORE = "dev-viewer";

type State = { on: string[]; path: string; sync: boolean };

function load(): State {
  const fallback: State = { on: ["phone", "desktop"], path: "/", sync: true };
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<State> | null;
    const fromUrl = new URLSearchParams(location.search).get("path");
    return {
      on: Array.isArray(s?.on) && s.on.length ? s.on : fallback.on,
      path: fromUrl ?? (typeof s?.path === "string" ? s.path : fallback.path),
      sync: typeof s?.sync === "boolean" ? s.sync : fallback.sync,
    };
  } catch {
    return fallback;
  }
}

function save(s: State) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    /* private mode: no memory, still works */
  }
}

const css = `
:root { color-scheme: dark; --bg:#111318; --panel:#1b1e25; --line:#2c313b; --ink:#e8eaf0; --dim:#9aa1b0; --acc:#4f8cff; }
* { box-sizing: border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--ink); font:14px/1.4 system-ui, sans-serif; }
#viewer { display:flex; flex-direction:column; height:100%; }
.bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
.bar form { display:flex; gap:6px; flex:1 1 260px; min-width:0; }
.bar input[type=text] { flex:1; min-width:0; font:13px ui-monospace, monospace; color:var(--ink); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
button, .chip { font:inherit; color:var(--ink); background:#262a33; border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; }
button:hover, .chip:hover { border-color:#4a5160; }
.chip[aria-pressed=true] { background:var(--acc); border-color:var(--acc); color:#fff; }
button:focus-visible, .chip:focus-visible, input:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
.ver { font:12px ui-monospace, monospace; color:var(--dim); }
.chips { display:flex; flex-wrap:wrap; gap:6px; }
label.sync { display:flex; gap:6px; align-items:center; color:var(--dim); }
.stage { flex:1; min-height:0; overflow:auto; display:flex; gap:${GAP}px; align-items:flex-start; justify-content:center; padding:${GAP}px 16px; }
.dev { flex:none; display:flex; flex-direction:column; gap:6px; }
.dev .meta { display:flex; justify-content:space-between; gap:8px; color:var(--dim); font-size:12px; white-space:nowrap; }
.dev .meta a { color:var(--acc); }
.screen { position:relative; overflow:hidden; border:1px solid var(--line); border-radius:10px; background:#fff; box-shadow:0 8px 30px #0006; }
.screen iframe { position:absolute; top:0; left:0; border:0; transform-origin:0 0; background:#fff; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

function framePath(f: HTMLIFrameElement): string | null {
  try {
    const l = f.contentWindow?.location;
    if (!l || l.protocol === "about:") return null;
    return l.pathname + l.search + l.hash;
  } catch {
    return null; // left the origin
  }
}

export function mount(root: HTMLElement) {
  document.head.append(el("style", { textContent: css }));
  const state = load();

  const input = el("input", { type: "text", value: state.path, ariaLabel: "Path" });
  const form = el("form", {}, input, el("button", { type: "submit", textContent: "Go" }));
  const chips = el("div", { className: "chips" });
  const syncBox = el("input", { type: "checkbox", checked: state.sync });
  const reload = el("button", { type: "button", textContent: "Reload all" });
  const bar = el(
    "div",
    { className: "bar" },
    form,
    chips,
    el("label", { className: "sync" }, syncBox, "Sync"),
    reload,
    el("span", { className: "ver", textContent: APP_VERSION, title: "version of this build" }),
  );
  const stage = el("div", { className: "stage" });
  root.append(bar, stage);

  let frames: { d: Device; f: HTMLIFrameElement; box: HTMLDivElement; size: HTMLSpanElement }[] = [];
  let last = state.path;

  const layout = () => {
    if (!frames.length) return;
    const width = stage.clientWidth - 32 - GAP * (frames.length - 1);
    const height = stage.clientHeight - 2 * GAP - 24;
    const sumW = frames.reduce((a, x) => a + x.d.w, 0);
    const maxH = Math.max(...frames.map((x) => x.d.h));
    const s = Math.max(0.2, Math.min(1, width / sumW, height / maxH));
    for (const x of frames) {
      x.box.style.width = `${Math.round(x.d.w * s)}px`;
      x.box.style.height = `${Math.round(x.d.h * s)}px`;
      x.f.style.width = `${x.d.w}px`;
      x.f.style.height = `${x.d.h}px`;
      x.f.style.transform = `scale(${s})`;
      x.size.textContent = `${x.d.w}×${x.d.h} · ${Math.round(s * 100)}%`;
    }
  };

  const go = (path: string) => {
    const p = path.startsWith("/") ? path : `/${path}`;
    last = p;
    input.value = p;
    state.path = p;
    save(state);
    for (const x of frames) if (framePath(x.f) !== p) x.f.src = p;
  };

  const build = () => {
    stage.replaceChildren();
    frames = DEVICES.filter((d) => state.on.includes(d.id)).map((d) => {
      const f = el("iframe", { title: `${d.label} ${d.w}×${d.h}`, src: state.path });
      const box = el("div", { className: "screen" }, f);
      const size = el("span");
      const open = el("a", { href: state.path, target: "_blank", rel: "noopener", textContent: "open" });
      f.addEventListener("load", () => {
        open.href = framePath(f) ?? state.path;
      });
      stage.append(
        el(
          "div",
          { className: "dev" },
          el("div", { className: "meta" }, el("span", { textContent: d.label }), size, open),
          box,
        ),
      );
      return { d, f, box, size };
    });
    layout();
  };

  for (const d of DEVICES) {
    const chip = el("button", { type: "button", className: "chip", textContent: d.label });
    chip.setAttribute("aria-pressed", String(state.on.includes(d.id)));
    chip.addEventListener("click", () => {
      state.on = state.on.includes(d.id) ? state.on.filter((x) => x !== d.id) : [...state.on, d.id];
      if (!state.on.length) state.on = [d.id];
      chip.setAttribute("aria-pressed", String(state.on.includes(d.id)));
      save(state);
      build();
    });
    chips.append(chip);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    go(input.value.trim() || "/");
  });
  syncBox.addEventListener("change", () => {
    state.sync = syncBox.checked;
    save(state);
  });
  reload.addEventListener("click", () => {
    for (const x of frames) x.f.contentWindow?.location.reload();
  });
  new ResizeObserver(layout).observe(stage);

  // Follow navigation inside any frame (links, client-side routes) in the others.
  setInterval(() => {
    for (const x of frames) {
      const p = framePath(x.f);
      if (p && p !== last) {
        if (state.sync) go(p);
        else {
          last = p;
          input.value = p;
        }
        break;
      }
    }
  }, 400);

  build();
}

const root = document.getElementById("viewer");
if (root) mount(root);
