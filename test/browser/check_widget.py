"""Browser check of the widget and the JS API.

Run: uv run --no-project --with playwright python3 test/browser/check_widget.py
It starts test/browser/harness.js (fake GitHub, relay, test page) and drives Chromium at 412 and 1440 px.
"""
import json
import re
import subprocess
import urllib.parse
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
failures = []
CHROME = "/usr/bin/google-chrome"  # the host Chrome; uv playwright versions often lack their own browser


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def control(base, path):
    with urllib.request.urlopen(base + path) as r:
        return json.loads(r.read())


WIDGET = "document.querySelector('papercuts-widget')"
SHADOW = WIDGET + "?.shadowRoot"


def ready(page):
    page.wait_for_function(f"window.papercuts && {SHADOW}?.querySelector('.tab')")


def issues(ctl):
    return control(ctl, "/mode?m=ok")["issues"]


def v2_base_checks(browser, ctl, page_url, width):
    """Widget v0.2 base: languages, hide hook, drag, dialogs, Ctrl+Enter, redacted queue, download, place."""
    control(ctl, "/mode?m=ok")
    ctx = browser.new_context(viewport={"width": width, "height": 860}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(page_url + "?lang=de")
    ready(page)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    check(f"{width}: German labels", host.locator("button.send").inner_text() == "Senden", host.locator("button.send").inner_text())
    check(f"{width}: idea kind offered", host.locator("select option[value=idea]").count() == 1)

    page.goto(page_url)
    ready(page)
    page.evaluate("window.papercutsHidden = () => true")
    page.wait_for_function(f"{SHADOW}.querySelector('.tab').hidden === true", timeout=3000)
    check(f"{width}: hide hook hides the tab", True)
    page.evaluate("window.papercutsHidden = () => false")
    page.wait_for_function(f"{SHADOW}.querySelector('.tab').hidden === false", timeout=3000)

    tab = host.locator(".tab")
    box = tab.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2 - 150, steps=8)
    page.mouse.up()
    moved = tab.bounding_box()["y"]
    check(f"{width}: drag moves the tab", moved < box["y"] - 100, f"{box['y']} -> {moved}")
    check(f"{width}: drag does not open the panel", host.locator(".panel").is_hidden())
    page.reload()
    ready(page)
    check(f"{width}: tab position kept after reload", abs(host.locator(".tab").bounding_box()["y"] - moved) < 3)
    page.evaluate("localStorage.removeItem('papercuts-pos-v1')")

    page.click("#open-dlg")
    page.keyboard.press("Alt+Shift+P")
    page.wait_for_function(f"{WIDGET}.parentElement?.id === 'dlg'", timeout=3000)
    host.locator("textarea").click()
    host.locator("textarea").fill("Dialog report " + str(width))
    check(f"{width}: panel inside modal dialog is usable", host.locator("textarea").input_value() == "Dialog report " + str(width))
    check(f"{width}: dialog stays open", page.evaluate("document.getElementById('dlg').open"))
    before = len(issues(ctl))
    host.locator("textarea").press("Control+Enter")
    page.wait_for_function(f"{SHADOW}.querySelector('.status').textContent.includes('#')")
    check(f"{width}: Ctrl+Enter sends", len(issues(ctl)) == before + 1)
    host.locator("button.close").click()
    page.click("#close-dlg")
    page.wait_for_function(f"{WIDGET}.parentElement === document.documentElement", timeout=3000)
    check(f"{width}: widget moves back after the dialog closes", True)

    page.evaluate("location.hash = 'far'; window.scrollTo(0, 600)")
    page.wait_for_timeout(200)
    r = page.evaluate("papercuts.report({kind: 'ux', text: 'place check ' + innerWidth, from: 'human'})")
    body = issues(ctl)[-1]["body"]
    marker = re.search(r"<!-- papercut-place: (\S+) -->", body)
    place = json.loads(urllib.parse.unquote(marker.group(1))) if marker else {}
    check(f"{width}: place has hash, scroll and viewport", place.get("hash") == "#far" and place.get("scrollY", 0) > 0 and place.get("viewport", {}).get("width") == width, str(place))

    control(ctl, "/mode?m=redirect")
    page.evaluate("papercuts.report({kind: 'bug', text: 'password=hunter2 in the log ' + innerWidth, from: 'human'})")
    stored = page.evaluate("""new Promise((ok) => { const q = indexedDB.open('papercuts-queue-v1', 1);
        q.onsuccess = () => { const g = q.result.transaction('reports').objectStore('reports').getAll(); g.onsuccess = () => ok(JSON.stringify(g.result)); }; })""")
    check(f"{width}: queue stores redacted text", "hunter2" not in stored and "[redacted]" in stored, stored[:200])
    control(ctl, "/mode?m=ok")
    page.evaluate("papercuts.flush()")

    page.goto(page_url + "?papercuts=download")
    ready(page)
    host.locator(".tab").click()
    check(f"{width}: download mode button", host.locator("button.send").inner_text() == "Download report", host.locator("button.send").inner_text())
    host.locator("textarea").fill("offline report " + str(width))
    n_before = len(issues(ctl))
    with page.expect_download() as dl:
        host.locator("button.send").click()
    saved = json.loads(Path(dl.value.path()).read_text())
    ok = subprocess.run(["node", "--input-type=module", "-e",
                         "import { normalizeReport } from './src/format.js'; const p = JSON.parse(process.argv[1]); process.exit(normalizeReport(p.report, p.from).ok ? 0 : 1);",
                         json.dumps(saved)], cwd=ROOT).returncode == 0
    check(f"{width}: downloaded file is a valid report", ok and saved.get("from") == "human", str(saved)[:200])
    check(f"{width}: download mode sends nothing", len(issues(ctl)) == n_before)
    check(f"{width}: no page errors in v0.2 checks", not errors, "; ".join(errors))
    ctx.close()


def sheet_checks(browser, ctl, page_url, width):
    """Drawing sheet with pen and pins, screen capture and voice buttons."""
    control(ctl, "/mode?m=ok")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(page_url)
    ready(page)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    check(f"{width}: no mark button before a picture is picked", host.locator("button.mark-pic").is_hidden())
    host.locator("button.pick").click()
    page.locator("#pic").click()
    check(f"{width}: mark button after picking a picture", host.locator("button.mark-pic").is_visible())
    host.locator("button.mark-pic").click()
    canvas = host.locator(".sheet canvas")
    canvas.wait_for(state="visible", timeout=3000)
    b = canvas.bounding_box()
    def at(fx, fy):
        return b["x"] + b["width"] * fx, b["y"] + b["height"] * fy
    for y in (0.3, 0.6):
        page.mouse.move(*at(0.2, y)); page.mouse.down(); page.mouse.move(*at(0.7, y), steps=6); page.mouse.up()
    host.locator(".sheet button.tool-pin").click()
    for fx in (0.3, 0.8):
        page.mouse.click(*at(fx, 0.5))
    pins = host.locator(".sheet .pins input")
    check(f"{width}: two pins with text fields", pins.count() == 2, str(pins.count()))
    host.locator(".sheet button.undo").click()
    check(f"{width}: undo removes the last mark", pins.count() == 1, str(pins.count()))
    page.mouse.click(*at(0.8, 0.5))
    pins.nth(0).fill("too dark")
    pins.nth(1).fill("cut off")
    host.locator(".sheet button.done").click()
    check(f"{width}: sheet closes and the panel shows the picture", host.locator(".sheet").is_hidden() and host.locator(".panel img.preview").is_visible())
    host.locator("textarea").fill(f"marked picture {width}")
    before = len(issues(ctl))
    host.locator("button.send").click()
    page.wait_for_function(f"{SHADOW}.querySelector('.status').textContent.includes('#')", timeout=10000)
    st = control(ctl, "/mode?m=ok")
    body = st["issues"][-1]["body"] if len(st["issues"]) > before else ""
    check(f"{width}: issue has the picture and the pins", "![papercut](" in body and "1. too dark" in body and "2. cut off" in body, body[:300])
    check(f"{width}: uploaded file is a PNG", st["uploads"] and st["uploads"][-1] == "89504e470d0a1a0a", str(st["uploads"][-1:]))
    check(f"{width}: panel forgets the picture after sending", host.locator(".panel img.preview").is_hidden())
    if width > 800:
        check(f"{width}: mark screen offered on desktop", host.locator("button.mark-screen").is_visible())
    check(f"{width}: no page errors in sheet checks", not errors, "; ".join(errors))
    ctx.close()

    touch = browser.new_context(viewport={"width": width, "height": 860}, has_touch=True, is_mobile=width < 800)
    page = touch.new_page()
    page.add_init_script("delete window.SpeechRecognition; delete window.webkitSpeechRecognition;")
    page.goto(page_url)
    ready(page)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    if width < 800:
        check(f"{width}: mark screen hidden on touch", host.locator("button.mark-screen").is_hidden())
    check(f"{width}: microphone hidden without speech API", host.locator("button.mic").is_hidden())
    touch.close()


def main():
    harness = subprocess.Popen(["node", str(ROOT / "test/browser/harness.js")], stdout=subprocess.PIPE, text=True)
    try:
        urls = json.loads(harness.stdout.readline())
        page_url, ctl = urls["page"], urls["control"]
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True) if Path(CHROME).exists() else p.chromium.launch()
            for width in (412, 1440):
                control(ctl, "/mode?m=ok")
                ctx = browser.new_context(viewport={"width": width, "height": 860})
                page = ctx.new_page()
                errors = []
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(page_url)
                host = page.locator("papercuts-widget")
                page.wait_for_function("window.papercuts && document.querySelector('papercuts-widget')?.shadowRoot?.querySelector('.tab')")
                check(f"{width}: tab visible", host.locator(".tab").is_visible())

                before = len(control(ctl, "/mode?m=ok")["issues"])
                host.locator(".tab").click()
                host.locator("button.pick").click()
                page.locator("#buy").click()
                target = host.locator(".target").inner_text()
                check(f"{width}: pick selects element", "buy" in target.lower(), target)
                host.locator("select").select_option("ux")
                host.locator("textarea").fill(f"Buy button is too small at {width}")
                host.locator("button.send").click()
                page.wait_for_function("document.querySelector('papercuts-widget').shadowRoot.querySelector('.status').textContent.includes('#')")
                issues = control(ctl, "/mode?m=ok")["issues"]
                check(f"{width}: pick and send creates issue", len(issues) == before + 1)
                body = issues[-1]["body"] if issues else ""
                check(f"{width}: context has element and commit", "#buy" in body and "abc1234" in body and "data-product" in body, body[:300])
                check(f"{width}: label from:human", issues and any(l["name"] == "from:human" for l in issues[-1]["labels"]))

                r = page.evaluate("papercuts.report({kind: 'tool', text: 'api check ' + innerWidth, where: 'test'})")
                check(f"{width}: api report returns issue", r.get("ok") and isinstance(r.get("issue"), int), str(r))
                r2 = page.evaluate("papercuts.report({kind: 'tool', text: 'API check ' + innerWidth, where: 'test'})")
                check(f"{width}: api report agent repeat deduped", r2.get("deduped") is True and r2.get("issue") == r.get("issue"), str(r2))
                check(f"{width}: no console errors in normal flow", not errors, "; ".join(errors))
                bad = page.evaluate("papercuts.report({kind: 'nope', text: 'x'})")
                check(f"{width}: api rejects bad kind without throw", bad.get("ok") is False and "help" in bad and not bad.get("queued"), str(bad))

                control(ctl, "/mode?m=redirect")
                q = page.evaluate("papercuts.report({kind: 'bug', text: 'queued while logged out ' + innerWidth, from: 'human'})")
                check(f"{width}: queues on redirect", q.get("queued") is True and q.get("ok") is False, str(q))
                st = page.evaluate("papercuts.status()")
                check(f"{width}: status counts queue", st.get("queued") == 1, str(st))
                control(ctl, "/mode?m=down")
                d = page.evaluate("papercuts.report({kind: 'bug', text: 'queued while relay down ' + innerWidth, from: 'human'})")
                check(f"{width}: queues when relay goes down", d.get("queued") is True, str(d))
                control(ctl, "/mode?m=ok")
                page.evaluate("papercuts.flush()")
                st = page.evaluate("papercuts.status()")
                texts = [i["body"] for i in control(ctl, "/mode?m=ok")["issues"]]
                check(f"{width}: queued reports sent later", st.get("queued") == 0 and any("queued while logged out" in t for t in texts) and any("queued while relay down" in t for t in texts), str(st))

                control(ctl, "/fail?code=404")
                perm = page.evaluate("papercuts.report({kind: 'bug', text: 'repo typo ' + innerWidth, from: 'human'})")
                st = page.evaluate("papercuts.status()")
                check(f"{width}: permanent github error is not queued", perm.get("queued") is False and perm.get("ok") is False and st.get("queued") == 0, f"{perm} {st}")
                control(ctl, "/fail?code=0")

                control(ctl, "/mode?m=down")
                lost = page.evaluate("(() => { indexedDB.open = () => { throw new Error('blocked'); }; return papercuts.report({kind: 'bug', text: 'no storage ' + innerWidth, from: 'human'}); })()")
                check(f"{width}: failed save is not reported as queued", lost.get("queued") is False and lost.get("ok") is False, str(lost))
                control(ctl, "/mode?m=ok")

                color = host.locator(".panel h2").evaluate("e => getComputedStyle(e).color")
                check(f"{width}: host css does not leak", color != "rgb(255, 0, 0)", color)
                sideways = page.evaluate("document.documentElement.scrollWidth > innerWidth")
                check(f"{width}: no horizontal scroll", not sideways)
                page.screenshot(path=str(ROOT / f".superpowers/widget-{width}.png"))
                ctx.close()

            for width in (412, 1440):
                v2_base_checks(browser, ctl, page_url, width)
                sheet_checks(browser, ctl, page_url, width)

            control(ctl, "/mode?m=down")
            ctx = browser.new_context(viewport={"width": 412, "height": 860})
            page = ctx.new_page()
            page.goto(page_url)
            page.wait_for_timeout(1000)
            state = page.evaluate("({api: typeof window.papercuts, host: !!document.querySelector('papercuts-widget')})")
            check("no widget and no API when relay down at load", state == {"api": "undefined", "host": False}, str(state))
            check("page still renders", page.locator("#buy").is_visible())
            ctx.close()
            browser.close()
    finally:
        harness.terminate()
    print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
