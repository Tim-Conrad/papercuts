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
    check(f"{width}: people get one input, no kind chips", host.locator(".kinds").count() == 0 and host.locator("textarea").count() == 1)

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
    host.locator("button.another").click()
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


def list_checks(browser, ctl, page_url, width):
    """The list of open papercuts in the panel: replies, badge, go to place."""
    control(ctl, "/mode?m=ok")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(page_url + "#far")
    ready(page)
    page.evaluate("window.scrollTo(0, 700)")
    r = page.evaluate("papercuts.report({kind: 'ux', text: 'list check ' + innerWidth, from: 'human'})")
    n = r.get("issue")
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    host.locator("button.list").click()
    items = host.locator(".items li")
    titles = items.all_inner_texts()
    check(f"{width}: list shows the open papercuts", any(f"list check {width}" in x for x in titles), str(titles)[:200])
    page.evaluate("history.replaceState(null, '', location.pathname); window.scrollTo(0, 0)")
    host.locator(f".items li[data-issue='{n}'] button.goto").click()
    page.wait_for_timeout(300)
    check(f"{width}: go to place restores hash and scroll", page.evaluate("location.hash") == "#far" and page.evaluate("scrollY") > 300, page.evaluate("location.hash + ' ' + scrollY"))

    control(ctl, f"/comment?n={n}&text=Fixed+in+abc1234")
    page.reload()
    ready(page)
    page.wait_for_function(f"{SHADOW}.querySelector('.tab .replies')?.textContent.trim().length > 0", timeout=5000)
    check(f"{width}: badge shows a new reply", True)
    host.locator(".tab").click()
    host.locator("button.list").click()
    reply = host.locator(f".items li[data-issue='{n}'] .reply").inner_text()
    check(f"{width}: list shows the reply text", "Fixed in abc1234" in reply, reply)
    page.reload()
    ready(page)
    page.wait_for_timeout(800)
    check(f"{width}: badge clears after the list was opened", host.locator(".tab .replies").inner_text().strip() == "")

    evil = urllib.parse.quote("x\n\n<!-- papercut-place: " + urllib.parse.quote(json.dumps({"url": "javascript:window.__pwned=1", "hash": ""})) + " -->\n")
    control(ctl, "/inject?body=" + evil)
    page.reload()
    ready(page)
    host.locator(".tab").click()
    host.locator("button.list").click()
    item = host.locator(".items li", has_text="injected")
    if item.locator("button.goto").count():
        item.locator("button.goto").click()
        page.wait_for_timeout(300)
    check(f"{width}: go to place never runs a javascript: URL", page.evaluate("window.__pwned") is None)
    host.locator("button.close").click() if host.locator("button.close").is_visible() else None

    page.goto(page_url)
    ready(page)
    page.click("#open-dlg")
    page.keyboard.press("Alt+Shift+P")
    page.wait_for_function(f"{WIDGET}.parentElement?.id === 'dlg'", timeout=3000)
    host.locator("button.pick").click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    check(f"{width}: Esc in pick mode keeps the dialog open", page.evaluate("document.getElementById('dlg').open"))
    check(f"{width}: Esc in pick mode returns to the panel", host.locator(".panel").is_visible())
    host.locator("button.close").click()
    page.click("#close-dlg")

    # A noisy picture as large as the sheet allows: its PNG is far above 8 MB.
    page.evaluate("""(() => { const c = document.createElement('canvas'); c.width = 2000; c.height = 2000; const x = c.getContext('2d');
        const d = x.createImageData(2000, 2000); for (let i = 0; i < d.data.length; i++) d.data[i] = (Math.random() * 256) | 0; x.putImageData(d, 0, 0);
        const img = document.createElement('img'); img.id = 'noise'; img.width = 200; img.height = 200; img.src = c.toDataURL('image/png'); document.body.prepend(img); })()""")
    page.wait_for_function("document.getElementById('noise').complete")
    host.locator(".tab").click()
    host.locator("button.pick").click()
    page.locator("#noise").click()
    host.locator("button.mark-pic").click()
    host.locator(".sheet button.done").click()
    host.locator("textarea").fill(f"noisy picture {width}")
    before = len(issues(ctl))
    host.locator("button.send").click()
    page.wait_for_function(f"{SHADOW}.querySelector('.status').textContent.length > 0 && !{SHADOW}.querySelector('.status').textContent.includes('…')", timeout=60000)
    st = host.locator(".status").inner_text()
    check(f"{width}: a picture above 8 MB still sends the report", len(issues(ctl)) == before + 1 and "#" in st, st)
    host.locator("button.close").click()

    control(ctl, "/mode?m=nolist")
    page.reload()
    ready(page)
    page.wait_for_timeout(800)
    host.locator(".tab").click()
    check(f"{width}: no list button when the relay refuses the list", host.locator("button.list").is_hidden())
    control(ctl, "/mode?m=ok")
    check(f"{width}: no page errors in list checks", not errors, "; ".join(errors))
    ctx.close()


def parity_checks(browser, ctl, page_url, width):
    """Features ported from anmerkung: Smaller after Parent, fullscreen, all storage keys."""
    control(ctl, "/mode?m=ok")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(page_url + "?storage=all")
    ready(page)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    host.locator("button.pick").click()
    page.locator("#buy").click()
    check(f"{width}: Smaller is off before Parent", host.locator("button.child").is_disabled())
    host.locator("button.parent").click()
    check(f"{width}: Parent goes up", "card" in host.locator(".target").inner_text())
    host.locator("button.child").click()
    check(f"{width}: Smaller goes back down", "buy" in host.locator(".target").inner_text())

    page.evaluate("localStorage.setItem('theme', 'dark'); localStorage.setItem('deck', 'k12'); localStorage.setItem('room-code', 'SECRET-ROOM')")
    page.evaluate("papercuts.report({kind: 'ux', text: 'storage all ' + innerWidth, from: 'human'})")
    body = issues(ctl)[-1]["body"]
    check(f"{width}: storage * sends all keys but the skipped ones", "k12" in body and "dark" in body and "SECRET-ROOM" not in body, body[:400])
    host.locator("button.close").click()

    page.evaluate("document.getElementById('tall').requestFullscreen()")
    page.wait_for_function("document.fullscreenElement && document.fullscreenElement.id === 'tall'", timeout=3000)
    page.wait_for_function(f"{WIDGET}.parentElement?.id === 'tall'", timeout=3000)
    check(f"{width}: widget moves into the fullscreen element", True)
    page.evaluate("document.exitFullscreen()")
    page.wait_for_function(f"{WIDGET}.parentElement === document.documentElement", timeout=3000)
    check(f"{width}: widget moves back after fullscreen", True)
    check(f"{width}: no page errors in parity checks", not errors, "; ".join(errors))
    ctx.close()


def v022_checks(browser, ctl, page_url, width):
    """Closed papercuts in the list, own strings for a language, replay steps."""
    control(ctl, "/mode?m=ok")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script("""window.papercutsStrings = { fr: { send: 'Envoyer', close: 'Fermer' } };
        window.papercutsReplay = () => [{ click: '#open-dlg' }];""")
    page.goto(page_url + "?lang=fr")
    ready(page)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    check(f"{width}: a site can add a language", host.locator("button.send").inner_text() == "Envoyer")
    check(f"{width}: missing strings fall back to English", host.locator("button.pick").inner_text() == "Point at something")
    r = page.evaluate("papercuts.report({kind: 'ux', text: 'steps check ' + innerWidth, from: 'human'})")
    body = issues(ctl)[-1]["body"]
    marker = re.search(r"<!-- papercut-place: (\S+) -->", body)
    place = json.loads(urllib.parse.unquote(marker.group(1))) if marker else {}
    check(f"{width}: place carries the replay steps", place.get("steps") == [{"click": "#open-dlg"}], str(place.get("steps")))
    control(ctl, f"/close?n={r['issue']}&fix=done+in+abc1234")
    page.reload()
    ready(page)
    host.locator(".tab").click()
    host.locator("button.list").click()
    item = host.locator(f".items li[data-issue='{r['issue']}']")
    txt = item.inner_text() if item.count() else ""
    check(f"{width}: list shows a recently closed papercut with its fix", "done in abc1234" in txt and item.get_attribute("class") == "closed", txt)
    check(f"{width}: no page errors in v0.2.2 checks", not errors, "; ".join(errors))
    ctx.close()


V03_CONFIG = json.dumps({
    "kinds": ["ux", "bug", "idea"],
    "fields": [{"id": "expected", "label": "What did you expect?", "required": True}, {"id": "device", "label": "Device", "options": ["phone", "desktop"]}],
    "presets": [{"kind": "ux", "text": "Too small to tap"}, {"kind": "bug", "text": "This does not load"}],
    "labels": ["area:web"],
})

FAKE_SPEECH = """
class FakeSpeech { constructor() { this.lang = ''; }
  start() { window.__speechLang = this.lang; setTimeout(() => {
    const r = (t, f) => { const a = [{ transcript: t }]; a.isFinal = f; return a; };
    this.onresult && this.onresult({ resultIndex: 0, results: [r('the menu', false)] });
    this.onresult && this.onresult({ resultIndex: 0, results: [r('the menu covers the button', true)] });
    this.onend && this.onend(); }, 60); }
  stop() { this.onend && this.onend(); } }
window.SpeechRecognition = FakeSpeech; window.webkitSpeechRecognition = FakeSpeech;
"""


def v03_checks(browser, ctl, page_url, width):
    """Ticket config in the widget, open(draft), shortcuts, deep link, two-finger press, voice first on phones."""
    control(ctl, "/mode?m=ok")
    control(ctl, "/config?json=" + urllib.parse.quote(V03_CONFIG))
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(page_url + "?shortcut=ctrl%2Bk")
    ready(page)
    host = page.locator("papercuts-widget")
    page.keyboard.press("Control+k")
    check(f"{width}: custom shortcut opens the panel", host.locator(".panel").is_visible())
    check(f"{width}: no voice-first button with a mouse", host.locator("button.speak").is_hidden())
    check(f"{width}: no kind chips even with a config", host.locator(".kinds").count() == 0)
    check(f"{width}: presets show as chips", host.locator(".presets button").count() == 2)
    host.locator(".presets button", has_text="Too small to tap").click()
    check(f"{width}: a preset fills the text", host.locator("textarea").input_value() == "Too small to tap")
    check(f"{width}: fields are not shown to people", host.locator(".fields").count() == 0)
    before = len(issues(ctl))
    host.locator("button.send").click()
    page.wait_for_function(f"{SHADOW}.querySelector('.status').textContent.includes('#')", timeout=10000)
    issue = issues(ctl)[-1]
    names = [l["name"] for l in issue["labels"]]
    check(f"{width}: a person is not blocked by a required field", len(issues(ctl)) == before + 1)
    check(f"{width}: the preset kind and the config labels go into the issue", "kind:ux" in names and "area:web" in names, str(names))
    host.locator("button.close").click()
    page.evaluate("papercuts.open({ kind: 'idea', text: 'A dark mode for the cart', fields: { expected: 'Dark colors', device: 'desktop' } })")
    check(f"{width}: open(draft) fills the panel", host.locator(".panel").is_visible() and host.locator("textarea").input_value() == "A dark mode for the cart")
    host.locator("button.send").click()
    page.wait_for_function(f"{SHADOW}.querySelector('.status').textContent.includes('#')", timeout=10000)
    issue = issues(ctl)[-1]
    check(f"{width}: draft kind and fields go into the issue", "**What did you expect?** Dark colors" in issue["body"] and any(l["name"] == "kind:idea" for l in issue["labels"]), issue["body"][:300])
    host.locator("button.close").click()

    page.goto(page_url + "#papercut")
    ready(page)
    page.wait_for_timeout(300)
    check(f"{width}: #papercut opens the panel", host.locator(".panel").is_visible())
    check(f"{width}: #papercut is removed from the URL", page.evaluate("location.hash") == "")
    check(f"{width}: no page errors in v0.3 checks", not errors, "; ".join(errors))
    ctx.close()

    phone = browser.new_context(viewport={"width": width, "height": 860}, has_touch=True, is_mobile=width < 800)
    page = phone.new_page()
    page.add_init_script(FAKE_SPEECH)
    page.goto(page_url)
    ready(page)
    host = page.locator("papercuts-widget")
    page.evaluate("""(() => {
      const t = (id, x, y) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: y });
      const a = [t(1, 100, 300), t(2, 160, 300)];
      document.body.dispatchEvent(new TouchEvent('touchstart', { touches: a, targetTouches: a, changedTouches: a, bubbles: true }));
    })()""")
    page.wait_for_timeout(800)
    check(f"{width}: a long press with two fingers opens the panel", host.locator(".panel").is_visible())
    page.evaluate("document.body.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }))")
    check(f"{width}: voice first on a touch screen", host.locator("button.speak").is_visible())
    host.locator("button.speak").click()
    page.wait_for_timeout(400)
    check(f"{width}: speech fills the text", host.locator("textarea").input_value() == "the menu covers the button", host.locator("textarea").input_value())
    check(f"{width}: speech uses the page language", page.evaluate("window.__speechLang") == "en", str(page.evaluate("window.__speechLang")))
    phone.close()
    control(ctl, "/config?json=")


def active_in_widget(page):
    return page.evaluate("(() => { const r = document.querySelector('papercuts-widget').shadowRoot; const a = r.activeElement; return a ? (a.className || a.localName) : null; })()")


def review_checks(browser, ctl, page_url, width):
    """Findings of the UX review: focus, Esc, success view, kinds, login state, voice errors, shortcuts."""
    control(ctl, "/mode?m=ok")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    warns = []
    page.on("console", lambda m: warns.append(m.text) if m.type == "warning" else None)
    page.goto(page_url)
    ready(page)
    host = page.locator("papercuts-widget")
    tab = host.locator(".tab")
    check(f"{width}: tab says it is collapsed", tab.get_attribute("aria-expanded") == "false")
    check(f"{width}: tab names its shortcut", tab.get_attribute("aria-keyshortcuts") == "Alt+Shift+P")
    tab.click()
    check(f"{width}: tab says it is expanded", tab.get_attribute("aria-expanded") == "true")
    check(f"{width}: panel is a modal dialog", host.locator(".panel").get_attribute("aria-modal") == "true")
    check(f"{width}: hidden tab is out of the tab order", page.evaluate("document.querySelector('papercuts-widget').shadowRoot.querySelector('.tab').inert") is True)
    check(f"{width}: no element attached without a tap", host.locator(".where").is_hidden())
    check(f"{width}: shortcuts are shown in the panel", host.locator(".shortcuts").is_visible() and "Alt+Shift+P" in host.locator(".shortcuts").inner_text())
    check(f"{width}: copy-link button exists", host.locator(".shortcuts button.copylink").count() == 1)
    host.locator("button.send").focus()
    for _ in range(30):
        page.keyboard.press("Tab")
        if active_in_widget(page) is None:
            break
    check(f"{width}: Tab stays inside the panel", active_in_widget(page) is not None, str(active_in_widget(page)))
    page.mouse.click(5, 5)
    page.keyboard.press("Escape")
    check(f"{width}: Esc closes the panel after a click on the page", host.locator(".panel").is_hidden())

    tab.click()
    host.locator("textarea").fill(f"review success view {width}")
    host.locator("button.send").click()
    page.wait_for_function(f"{SHADOW}.querySelector('.status').textContent.includes('#')", timeout=10000)
    body = issues(ctl)[-1]
    check(f"{width}: no kind chosen files as other", any(l["name"] == "kind:other" for l in body["labels"]), str([l["name"] for l in body["labels"]]))
    check(f"{width}: success view hides the form and the send button", host.locator(".form-area").is_hidden() and host.locator("button.send").is_hidden() and host.locator("button.another").is_visible())
    host.locator("button.another").click()
    check(f"{width}: report another shows the form again", host.locator("textarea").is_visible() and host.locator("button.send").is_visible() and host.locator(".status").inner_text() == "")
    host.locator("button.close").click()
    page.locator("#buy").click()
    page.keyboard.press("Alt+Shift+P")
    check(f"{width}: the last tapped element attaches itself", host.locator(".where").is_visible() and "buy" in host.locator(".target").inner_text().lower(), host.locator(".target").inner_text())
    host.locator("button.close").click()
    ctx.close()

    control(ctl, "/mode?m=loggedout")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    page.goto(page_url)
    page.wait_for_function(f"{SHADOW}?.querySelector('.tab')", timeout=5000)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    check(f"{width}: logged out shows a log-in hint", "log in" in host.locator(".status").inner_text().lower(), host.locator(".status").inner_text())
    ctx.close()

    control(ctl, "/mode?m=nostatus")
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    page = ctx.new_page()
    warns = []
    page.on("console", lambda m: warns.append(m.text) if m.type == "warning" else None)
    page.goto(page_url)
    page.wait_for_timeout(1200)
    check(f"{width}: relay down logs a warning", any("papercuts" in w and "not reachable" in w for w in warns), str(warns))
    ctx.close()
    control(ctl, "/mode?m=ok")

    phone = browser.new_context(viewport={"width": width, "height": 860}, has_touch=True, is_mobile=width < 800)
    page = phone.new_page()
    page.add_init_script("class F{start(){setTimeout(()=>{this.onerror&&this.onerror({error:'not-allowed'});this.onend&&this.onend();},30)} stop(){}}; window.SpeechRecognition=F; window.webkitSpeechRecognition=F;")
    page.goto(page_url + "?lang=de")
    ready(page)
    host = page.locator("papercuts-widget")
    host.locator(".tab").click()
    check(f"{width}: touch open focuses no text field", active_in_widget(page) != "textarea" if active_in_widget(page) else True, str(active_in_widget(page)))
    host.locator("button.speak").click()
    page.wait_for_timeout(200)
    st = host.locator(".status").inner_text()
    check(f"{width}: a blocked microphone gives a plain message", "Mikrofon" in st and "not-allowed" not in st, st)
    sizes = page.evaluate("""(() => { const r = document.querySelector('papercuts-widget').shadowRoot;
        return [...r.querySelectorAll('.kinds button, button.pick, button.close, button.send')].map(b => Math.round(b.getBoundingClientRect().height)); })()""")
    check(f"{width}: touch targets are at least 44 px", min(sizes) >= 44, str(sizes))
    phone.close()


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
                list_checks(browser, ctl, page_url, width)
                parity_checks(browser, ctl, page_url, width)
                v022_checks(browser, ctl, page_url, width)
                v03_checks(browser, ctl, page_url, width)
                review_checks(browser, ctl, page_url, width)

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
