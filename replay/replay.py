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
    page.evaluate("([x, y]) => window.scrollTo(x, y)", [data.get("scrollX") or 0, data.get("scrollY") or 0])
    if data.get("selector"):
        page.evaluate("""s => { const e = document.querySelector(s); if (e) { e.style.outline = '3px solid red'; e.style.outlineOffset = '2px'; } }""", data["selector"])
    # The picture shows the page, not the papercuts tab.
    page.add_style_tag(content="papercuts-widget { display: none !important; }")
    page.wait_for_timeout(300)
    page.screenshot(path=data["out"])
    browser.close()
print(data["out"])
