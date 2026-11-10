"""Browser check of the widget and the JS API.

Run: uv run --no-project --with playwright python3 test/browser/check_widget.py
It starts test/browser/harness.js (fake GitHub, relay, test page) and drives Chromium at 412 and 1440 px.
"""
import json
import subprocess
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

                color = host.locator(".panel h2").evaluate("e => getComputedStyle(e).color")
                check(f"{width}: host css does not leak", color != "rgb(255, 0, 0)", color)
                sideways = page.evaluate("document.documentElement.scrollWidth > innerWidth")
                check(f"{width}: no horizontal scroll", not sideways)
                page.screenshot(path=str(ROOT / f".superpowers/widget-{width}.png"))
                ctx.close()

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
