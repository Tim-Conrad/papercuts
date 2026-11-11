# Papercuts v0.2 and the lab rollout: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Papercuts v0.2 can do what pen-and-paper's anmerkung does, the lab relay runs with the `gh` login, and every lab app with a page uses papercuts behind a feature flag.

**Architecture:** Part A extends the papercuts repo: pictures (GitHub upload, relay fallback), relay read paths, CLI commands, and the widget features. Part B deploys the relay in the lab and migrates the apps, one PR per app repo. Each friction during Part B becomes a papercut against papercuts and gets fixed before the next app.

**Tech Stack:** Node.js 22 stdlib (no runtime deps), vanilla JS widget in Shadow DOM, Playwright via `uv` for browser checks and replay, Docker, Traefik and Authelia.

**Spec:** `docs/superpowers/specs/2026-11-11-papercuts-v0.2-lab-design.md` (builds on `2026-11-10-papercuts-design.md`).

## Global Constraints

- No runtime npm dependencies. Node >= 22. Ask Tim before adding any dependency.
- Writing style ASD-STE100 for README, docs, comments, commit messages, PR text and error messages.
- Never read, echo or commit secrets. Never print the `gh` token. Never read files under `secrets/` or `~/.config/gh/hosts.yml`.
- Every change happens on a branch. Lab apps: a separate clone under `~/code/`, never the live folder in `~/lab/apps/`. Deploy with `./lab-ctl deploy <app>`.
- Before each PR, follow the `visual-pr` skill. Each UI change shows Before and After screenshots of the same view.
- Feature flag contract: if `PAPERCUTS_URL` is set, the page gets `<script src="$PAPERCUTS_URL/papercuts.js" data-repo="..." ...>`. Otherwise the page gets nothing. No public build sets it.
- Widget limits: report text 300 chars, PNG max 8 MB, PNG magic bytes checked on the relay.
- Kinds: `bug, ux, copy, tool, rule, path, idea, other`. Widget kinds: `bug, ux, copy, idea, other`.
- The sealed player and GM copies get no widget.
- Exit codes of the CLI stay 0 / 1 / 2. Output stays TOON.

## Review Focus

- A picture upload that fails (network, 404 of the undocumented endpoint, token without upload rights) must still file the issue, with the picture on the relay and a link.
- A report body near the size limit with a PNG must not cut the YAML block or the markers.
- The widget inside an open modal `<dialog>` must stay clickable and must not close the dialog.
- A published copy (no `PAPERCUTS_URL`) must make zero requests to the relay.
- `GET /list` from a foreign origin must return 403, and must not leak issue titles.

---

## Part A: papercuts v0.2 (repo `~/code/papercuts`, branch `feat/v0.2`)

### Task 1: Core fixes from the v0.1 review

**Files:**
- Modify: `src/format.js` (KINDS, WIDGET_KINDS), `src/github.js` (401 handling), `src/cli.js` (setup: atomic write, hook command)
- Test: `test/format.test.js`, `test/file.test.js`, `test/cli.test.js`

**Interfaces:**
- Produces: `KINDS` includes `idea`. `WIDGET_KINDS = ['bug','ux','copy','idea','other']`. `githubClient` retries once after a 401 with a fresh token.

- [ ] **Step 1: Write failing tests**
  - `normalizeReport({kind:'idea',...})` is ok.
  - `401 clears cached token`: the fake GitHub answers 401 once (new fake option `failOnce: 401`). The credential `token()` gets a call count. Expect the call to succeed and `token()` to be called twice.
  - `setup writes settings atomically`: after `setup`, no `*.tmp` file is left, and a settings file with invalid JSON is not overwritten (exit 1, help line names the file).
  - `hook command uses PATH first`: the hook command in `~/.claude/settings.json` matches `/command -v papercuts/` and still contains the stored absolute path as fallback.
- [ ] **Step 2: Run `npm test`.** Expected: the four new tests fail.
- [ ] **Step 3: Implement.** Write to `<file>.tmp`, then `rename`. Hook command: `sh -c 'command -v papercuts >/dev/null && exec papercuts --hook || exec "<node>" "<bin>" --hook'`, quoted for JSON.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `Core fixes: idea kind, fresh token after 401, atomic setup`.

### Task 2: Pictures and pins in the issue

**Files:**
- Modify: `src/format.js`, `src/github.js`, `src/file.js`, `src/relay.js`, `src/config.js`
- Create: `src/shots.js`
- Test: `test/format.test.js`, `test/file.test.js`, `test/relay.test.js`, `test/fake-github.js`

**Interfaces:**
- Produces:
  - `normalizeReport` accepts `shot` (string `data:image/png;base64,...`) and `pins` (array of `{nr:int, text:string<=120}`, max 20). It returns `report.shot` as a `Buffer` or `undefined`. A bad PNG gives `{ok:false, error:'shot is not a PNG', help}`.
  - `githubClient(...).uploadAsset(repo, buffer, name) -> {url}`. It reads `repository_id` from `GET /repos/{repo}` (cached) and posts to `${uploadBase}/user-attachments/assets?content_type=image/png&name=&repository_id=`. Option `uploadBase` (default `https://uploads.github.com`).
  - `shotStore(dir) -> { save(id, buffer) -> path, read(id) -> Buffer|null }`. File names `^[A-Za-z0-9_-]{1,64}\.png$` only.
  - `buildIssue(report, target, {shotUrl})` puts `![papercut](<shotUrl>)` after the sentence, and the pins as a numbered list.
  - Relay: `GET /shots/<id>.png` (`image/png`, 404 if missing). `POST /report` body limit 12 MB.
  - Config: `PAPERCUTS_SHOTS_DIR` (default `./shots`), `PAPERCUTS_PUBLIC_URL` (for the fallback link).
- [ ] **Step 1: Write failing tests**
  - format: valid PNG data URL becomes a Buffer; JPEG data or a wrong magic number fails; more than 8 MB fails; pins are redacted and cut.
  - file: `uploads picture and embeds it` (fake upload endpoint returns `{href}`), `upload 404 falls back to relay link` (issue body contains `${publicUrl}/shots/<id>.png`, file exists in the store, `ok:true`), `retry with same id does not upload twice`.
  - relay: `GET /shots/<id>.png` returns the bytes; `GET /shots/../x.png` returns 404; a 9 MB body with a PNG returns 400 `shot is not a PNG` or the size error, never 500.
- [ ] **Step 2: Run `npm test`.** Expected: new tests fail.
- [ ] **Step 3: Implement.** The fake GitHub gets `POST /user-attachments/assets` on the same server, returning `{href: '<base>/assets/<n>'}`, and a switch `state.uploadFail`. Check the real response field name in the `GH_DEBUG=api` output of `gh issue create --attach` before you code it (it was not printed in the probe on 2026-11-11). Upload happens only after the id and fingerprint dedupe found nothing.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Live check** on `Tim-Conrad/papercuts` with the `gh` source: one report with a 1 kB PNG shows the picture inline. Close the issue.
- [ ] **Step 6: Commit** `Pictures and pins: upload with the gh login, relay fallback`.

### Task 3: Relay read paths and the place of a report

**Files:**
- Modify: `src/format.js` (place marker), `src/relay.js`, `src/github.js` (none new expected)
- Test: `test/format.test.js`, `test/relay.test.js`

**Interfaces:**
- Produces:
  - `report.context.place = {url, hash, scrollX, scrollY}` from the widget. `buildIssue` adds `<!-- papercut-place: <encodeURIComponent(JSON)> -->`. `parseMarkers` returns `place`.
  - `GET /list?repo=owner/name` -> `{ok, repo, items:[{issue, title, kind, from, url, created, place, replies:[{at, text<=300}], replyCount, plus}]}`. Replies are comments that do not start with `+1`. Cache 30 s per repo. Browser request: origin must be allowed, else 403 `{ok:false, error:'origin not allowed'}` without items. No `Origin` header: allowed (CLI on the proxy network). Repo must pass `PAPERCUTS_REPOS`.
- [ ] **Step 1: Write failing tests:** place marker round trip (with `-->` in the URL); `/list` for an allowed origin returns items with replies; foreign origin 403 and the body has no `items`; repo outside the allow list 403; second call within 30 s makes no GitHub request.
- [ ] **Step 2: Run.** Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** `Relay: list of open papercuts with replies and place`.

### Task 4: The relay with the gh login in a container

**Files:**
- Modify: `Dockerfile`, `src/config.js`, `src/credential.js`, `docker-compose.example.yml` -> rename to `docker-compose.yml` (the lab stack, also the example)
- Test: `test/cli.test.js` or a new `test/config.test.js`

**Interfaces:**
- Produces: `PAPERCUTS_CREDENTIAL=gh|file` (default `gh` when `PAPERCUTS_TOKEN_FILE` is unset). `credentialFrom({source:'gh'})` passes `GH_CONFIG_DIR` from the env through.
- [ ] **Step 1: Write failing test:** `loadConfig` with `PAPERCUTS_CREDENTIAL=gh` and `GH_CONFIG_DIR=/x` gives `{source:'gh'}` and the child env of `gh auth token` has `GH_CONFIG_DIR=/x` (fake `gh` script that prints its env var name check, never a real token).
- [ ] **Step 2: Run.** Expected: fail.
- [ ] **Step 3: Implement.** Dockerfile: `apk add --no-cache github-cli`, user `node`. Compose: `read_only: true`, `tmpfs: /tmp`, volume `shots:/data/shots`, `${HOME}/.config/gh:/gh:ro`, `GH_CONFIG_DIR=/gh`, `PAPERCUTS_SHOTS_DIR=/data/shots`, `PAPERCUTS_PUBLIC_URL=https://papercuts.lab.t7d.dev`, `mem_limit: 128m`, logging limits, proxy network, Traefik labels with `authelia@file,security-headers@file`, Homepage labels. No `ports:`. The container user must read `hosts.yml` (mode 600, owner `developer`, uid 1001): run the container as `user: "1001:1001"`.
- [ ] **Step 4: Run** `npm test`, then build the image and run it with the compose file under a throwaway project name and router `papercuts-dev`. Check `docker exec <c> gh auth status` exits 0 without printing the token (`2>&1 | grep -c Logged`), and `/status` answers.
- [ ] **Step 5: Commit** `Relay container uses the gh login read-only`.

### Task 5: CLI: setup credential, shot, import, replay

**Files:**
- Modify: `src/cli.js`
- Create: `replay/replay.py` (Playwright through `uv`, no npm dependency)
- Test: `test/cli.test.js`

**Interfaces:**
- Produces:
  - `setup --credential gh|file [--token-file <path>]` writes `credential` into the config. Default `gh`.
  - `shot <issue> [--out <file>]`: finds the picture link in the issue body. GitHub asset: download with the token. Relay link: download from `PAPERCUTS_RELAY_INTERNAL` (env or config) or the public URL. Writes `papercut-<issue>.png` by default. Prints `shot: <path>`.
  - `import <file.json>`: files a report saved by `?papercuts=download`. Same output as `add`.
  - `replay <issue> [--out <file>] [--base <url>]`: reads `place`, viewport and storage from the issue. With `uv` on the PATH, runs `replay/replay.py` and prints `replay: <png>`. Without `uv`, prints the replay data as TOON with a help line.
- [ ] **Step 1: Write failing tests:** setup writes `credential: "gh"`; `shot` on an issue with a fake asset URL writes the file; `shot` on an issue without picture exits 1 with help; `import` of a saved file creates the issue and a second import returns the same issue; `replay` with `PATH` lacking `uv` prints `url:`, `viewport:` and `help:`; `replay --base` replaces the origin.
- [ ] **Step 2: Run.** Expected: fail.
- [ ] **Step 3: Implement.** `replay.py` gets argv JSON on stdin, sets viewport, `localStorage` before load (init script), hash and scroll, draws a red 3 px outline on the element by its CSS path, writes the PNG.
- [ ] **Step 4: Run** `npm test` and one real replay against the browser harness page.
- [ ] **Step 5: Commit** `CLI: credential choice, shot, import and replay`.

### Task 6: Widget base: languages, placement, hooks, place, download

**Files:**
- Modify: `widget/papercuts.js`, `test/browser/harness.js`, `test/browser/page.html`, `test/browser/check_widget.py`

**Interfaces:**
- Consumes: `/report` with `context.place`, `WIDGET_KINDS` from Task 1.
- Produces: `data-lang` (`en` default, `de`). One string table `T = {en:{...}, de:{...}}`. `window.papercutsHidden` checked on each open. Tab position saved in `localStorage` key `papercuts-pos-v1`. The host element moves into the top open modal `<dialog>` while one is open. `Ctrl+Enter` sends. The queue stores redacted text (copy of the `SECRET` regex from `src/format.js`, with a unit test that compares both regex sources). `?papercuts=download` turns the send button into "Download report" (JSON file with `{from, report}`).
- [ ] **Step 1: Write failing browser checks:** German labels with `data-lang="de"`; `papercutsHidden = () => true` hides the tab; drag the tab, reload, same position; open a modal dialog on the test page, open the widget, the panel is visible and clickable, the dialog stays open; `Ctrl+Enter` sends; the queued IndexedDB record holds `[redacted]` for `password=hunter2`; `?papercuts=download` downloads a JSON that `papercuts import` accepts; `place.hash` and `scrollY` are in the issue.
- [ ] **Step 2: Run** `npm run check:browser`. Expected: new checks fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check:browser` and `npm test`. Expected: all pass at 412 and 1440.
- [ ] **Step 5: Commit** `Widget: languages, drag, dialogs, hide hook, download`.

### Task 7: Widget drawing sheet, screen capture, voice

**Files:**
- Modify: `widget/papercuts.js`, browser test files

**Interfaces:**
- Consumes: `shot` and `pins` of Task 2.
- Produces: buttons "Mark picture" (when the picked element is or contains an `<img>`), "Mark screen" (only when `getDisplayMedia` exists and `pointer: fine`), microphone (only when `SpeechRecognition` or `webkitSpeechRecognition` exists). Sheet tools: pen, numbered pin with one text line, undo, clear, cancel, done. Done gives `shot` (PNG data URL, scaled so that the long side is at most 2000 px) and `pins`.
- [ ] **Step 1: Write failing browser checks:** mark the test image: two pen strokes and two pins with text by pointer events, done, send; the issue body has the image link and `1. <text>`; undo removes the last mark; "Mark screen" is hidden at 412 px with touch emulation; the microphone is hidden when the API is missing (delete it in an init script).
- [ ] **Step 2: Run.** Expected: fail.
- [ ] **Step 3: Implement.** Cross-origin images taint the canvas: load the image again with `crossOrigin='anonymous'`, and if that fails show "This picture cannot be marked" and keep the report without picture.
- [ ] **Step 4: Run** both suites. Expected: pass.
- [ ] **Step 5: Commit** `Widget: drawing sheet, screen capture, voice input`.

### Task 8: Widget list of open papercuts

**Files:**
- Modify: `widget/papercuts.js`, browser test files

**Interfaces:**
- Consumes: `GET /list` of Task 3.
- Produces: a "Open papercuts (n)" view in the panel, newest first, with kind, title, age, reply count, the newest reply text, and "Go to place" (sets `location.hash`, then scrolls to `scrollX/scrollY`, only for the same path). A badge on the tab counts papercuts with replies not seen yet. Seen state in `localStorage` key `papercuts-seen-v1` as `issue:replyCount`.
- [ ] **Step 1: Write failing browser checks:** list shows the issues of the harness repo; a comment added on the fake GitHub shows as a badge after reload and clears after the list is opened; "Go to place" restores the hash; a relay that answers 403 for `/list` shows no list button and no console error.
- [ ] **Step 2: Run.** Expected: fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both suites. Expected: pass.
- [ ] **Step 5: Commit** `Widget: list of open papercuts with replies`.

### Task 9: Docs, final review, release v0.2.0

**Files:**
- Modify: `README.md`, `AGENTS.md`, `skills/papercuts/SKILL.md` (generated), `package.json` (version `0.2.0`), `src/config.js` (`VERSION`)

- [ ] **Step 1:** Update the README for the credential choice and its scope warning, pictures, the list, replay, shot, import, the feature flag contract with one example per server type, `data-lang`, `papercutsHidden`, and the sealed rule as a general warning ("do not load papercuts on pages that show decrypted or secret content"). Run `node bin/papercuts.js skill --check` after regenerating.
- [ ] **Step 2:** Run `npm test` and `npm run check:browser`. Expected: all pass.
- [ ] **Step 3:** Final whole-branch review on the most capable model, then one fix pass.
- [ ] **Step 4:** PR `feat/v0.2` -> `main` with the `visual-pr` skill (widget screenshots Before v0.1, After v0.2). Merge after CI. Tag `v0.2.0`, create the release.
- [ ] **Step 5:** On this host: `npm install -g github:Tim-Conrad/papercuts#v0.2.0`, then `papercuts setup --target per-project --credential gh --hooks claude,codex`, then `papercuts doctor`. Expected: 3/3 checks pass.

---

## Part B: the lab

### Task 10: The lab relay

**Files:**
- Create: `~/lab/apps/papercuts` as a clone of `Tim-Conrad/papercuts` at the default branch (precedent: `kleinbahn` is a clone of `tiny-train`).
- Modify (lab repo, branch `apps/papercuts`): `lab-ctl` (if the app list is hard coded), `bootstrap.sh`, `apps/CLAUDE.md`, `.gitignore`.

- [ ] **Step 1:** `./lab-ctl up papercuts`. Check from a container on `proxy`: `/healthz` is `ok`, `/status` shows `0.2.0`.
- [ ] **Step 2:** Check that `https://papercuts.lab.t7d.dev/papercuts.js` from the host shell redirects to the login (Authelia is in front).
- [ ] **Step 3:** File one test report through the relay from a container on `proxy` with `Origin: https://scanner.lab.t7d.dev` for `Tim-Conrad/papercuts`. Expected: an issue. Close it.
- [ ] **Step 4:** Lab repo PR (visual-pr, no UI), merge, `./lab-ctl status` shows the stack healthy.

### Task 11: pen-and-paper

**Clone:** `~/code/pen-and-paper` (create it if missing), branch `papercuts`.

- [ ] **Step 1: Feature inventory.** Make a table: every anmerkung feature (from `anmerkung.js`, `anmerkung.py`, `anmerkung_zeigen.py`, `devserver.py`) against its papercuts counterpart. **Stop and show Tim each feature that does not move.** Continue after his answer.
- [ ] **Step 2: Flag.** nginx: a template under `/etc/nginx/templates/` adds the tag with `sub_filter` only when `PAPERCUTS_URL` is set (an entrypoint script picks one of two configs). The review site (`devserver.py`) adds the same tag when `PAPERCUTS_URL` is set. Attributes: `data-repo="Tim-Conrad/pen-and-paper" data-lang="de"`, `data-commit` where known. `window.papercutsHidden` covers kids mode, `pruefen=1`, `nurdruck=1` and print.
- [ ] **Step 3: Remove** `anmerkung.py`, `anmerkung_zeigen.py`, `karten/webseite/anmerkung.js`, `anmerkung.css`, `papercut.py`, their tests and skills, `/api/anmerkung` in `devserver.py`, the `AGENTS.md`/`CLAUDE.md` lines. Add the papercuts block to `AGENTS.md`.
- [ ] **Step 4: Tests.** Run the repo's test suite. Write a check that the page without `PAPERCUTS_URL` contains no `papercuts.js` and makes no request to the relay.
- [ ] **Step 5: Relabel** the closed `anmerkung` issues: add `papercut` and `from:human`.
- [ ] **Step 6: PR** with Before (anmerkung tab) and After (papercuts tab) screenshots. **Stop: Tim checks it on the review site.** After his OK, merge and `./lab-ctl deploy pen-and-paper`. sealed rebuilds from pen-and-paper: check that `pen-and-paper-sealed.lab.t7d.dev` has no `papercuts.js`.

### Task 12-20: The other apps (one task per app)

Order: fitness, organizer, scanner, klima, apk-market, humidity-checker, scrcpy-lite, kleinbahn, sealed admin.

For each app, in a clone under `~/code/<repo>`, branch `papercuts`:

- [ ] **Step 1:** Find where the server delivers `index.html`. Add the tag only when `PAPERCUTS_URL` is set (FastAPI: read the env var when it serves the file; nginx: the pen-and-paper template pattern; Vite: at serve time, never at build time). `data-repo` = the repo of the app.
- [ ] **Step 2:** Write a test in the app's own test style: with the env var the page has the tag, without it the page has none.
- [ ] **Step 3:** Set `PAPERCUTS_URL=https://papercuts.lab.t7d.dev` in the lab `docker-compose.yml` and the dev compose. Add the `AGENTS.md` block.
- [ ] **Step 4:** Run the app's tests. Start the dev copy and check through Chrome that the tab shows and that one report from the dev copy creates an issue in the app repo. Close that issue.
- [ ] **Step 5:** PR with Before and After screenshots of the main view, merge, `./lab-ctl deploy <app>`. For klima, deploy only if it runs.
- [ ] **Step 6:** File each friction from this app as `papercuts add` against `Tim-Conrad/papercuts`. Fix the ones that block the next app before you start it, with a test, on a branch, with a PR.

Special cases:
- **kleinbahn:** the public build for `tiny-train.beacon.host` must not set the flag. Check the public build output for `papercuts`.
- **sealed admin:** `data-repo="Tim-Conrad/sealed"`. The sealed web copies get nothing. Check one built copy for `papercuts`.
- **humidity-checker:** the live DB is tracked in git, and `lab-ctl deploy` refuses it. Follow the manual deploy steps in its memory note.

### Task 21: Close out

- [ ] **Step 1:** `papercuts list` in `Tim-Conrad/papercuts`: every open papercut from the rollout is fixed or listed for Tim.
- [ ] **Step 2:** Final message: rulings, deferred minors, open papercuts, and the steps to make the repo public (then merge site PR #30).
