"""Replay a papercut: open the page as the reporter saw it and frame the element in red.

papercuts replay runs this through uv. It reads one JSON object on stdin:
{url, viewport: {width, height}, scrollX, scrollY, selector, storage: {key: value}, out}
and prints the path of the PNG.
PAPERCUTS_CHROME names a Chrome binary when the Playwright browser is not installed.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

data = json.load(sys.stdin)
chrome = os.environ.get("PAPERCUTS_CHROME") or ("/usr/bin/google-chrome" if os.path.exists("/usr/bin/google-chrome") else None)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=chrome, headless=True) if chrome else p.chromium.launch()
    vp = data.get("viewport") or {"width": 1280, "height": 800}
    ctx = browser.new_context(viewport={"width": vp["width"] or 1280, "height": vp["height"] or 800})
    # The storage must exist before the page script reads it.
    ctx.add_init_script("(s => { try { for (const k in s) localStorage.setItem(k, s[k]); } catch (e) {} })(%s)" % json.dumps(data.get("storage") or {}))
    page = ctx.new_page()
    page.goto(data["url"], wait_until="networkidle")
    # Clicks that bring back a state without a URL, for example an open dialog.
    for step in data.get("steps") or []:
        try:
            page.click(step["click"], timeout=5000)
            page.wait_for_timeout(300)
        except Exception as e:
            print(f"replay: step {step['click']} failed: {e}", file=sys.stderr)
    page.evaluate("([x, y]) => window.scrollTo(x, y)", [data.get("scrollX") or 0, data.get("scrollY") or 0])
    marks = data.get("marks") or ([{"selector": data["selector"]}] if data.get("selector") else [])
    # Each mark gets a red frame and its number, as the reporter saw it.
    page.evaluate("""marks => marks.forEach((m, i) => {
      let r;
      if (m.selector) { const e = document.querySelector(m.selector); if (!e) return; const b = e.getBoundingClientRect(); r = { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height }; }
      else r = { x: m.box.x, y: m.box.y, w: m.box.w, h: m.box.h };
      const f = document.createElement('div');
      Object.assign(f.style, { position: 'absolute', left: (r.x - 3) + 'px', top: (r.y - 3) + 'px', width: (r.w + 6) + 'px', height: (r.h + 6) + 'px',
        border: '3px solid #d13438', borderRadius: '6px', zIndex: 2147483647, pointerEvents: 'none' });
      const n = document.createElement('div');
      n.textContent = String(i + 1);
      Object.assign(n.style, { position: 'absolute', left: '-12px', top: '-12px', width: '22px', height: '22px', borderRadius: '11px', background: '#d13438',
        color: '#fff', font: 'bold 12px system-ui', display: 'flex', alignItems: 'center', justifyContent: 'center' });
      f.append(n); document.body.append(f);
    })""", marks)
    # The picture shows the page, not the papercuts tab.
    page.add_style_tag(content="papercuts-widget { display: none !important; }")
    page.wait_for_timeout(300)
    page.screenshot(path=data["out"])
    browser.close()
print(data["out"])
