# Papercuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared place where Tim and his agents report friction on local sites and in terminals. Each report becomes a GitHub issue. A Tools sheet on t7d.dev shows the README.

**Architecture:** A Node.js package with no dependencies has four parts. A format core validates, redacts, fingerprints, and builds issues. A filing core dedupes and talks to GitHub through a pluggable credential. A relay is an HTTP server that serves the widget and accepts reports. An AXI CLI is for agents. The site gets a deploy-time generator that renders the README from the latest release tag.

**Tech Stack:** Node 22 (`node:http`, `node:test`, global `fetch`), plain browser JS (Shadow DOM, IndexedDB). Site: Python 3 stdlib plus Python-Markdown 3.11.3 in CI only. Browser check: `uv run --no-project --with playwright` (the existing host pattern, not a package dependency).

**Spec:** `docs/superpowers/specs/2026-11-10-papercuts-design.md`

## Global Constraints

- Zero runtime dependencies in `package.json`. `"engines": {"node": ">=22"}`, `"type": "module"`, `"license": "MIT"`.
- Every text that people read (README, help, errors, comments) follows ASD-STE100: no contractions, no "should/may/might/could", max 20 words for an instruction and 25 for a description.
- No GitHub token in the browser, in a log, in an issue, in argv, or in an error message. Redact with the `papercut.py` `GEHEIM` pattern (ported verbatim, see Task 1).
- Labels: `papercut`, `from:human` | `from:agent`, `kind:<kind>`. In central mode also `project:<owner>/<repo>`.
- Kinds: `bug`, `ux`, `copy`, `tool`, `rule`, `path`, `other`. The widget offers `bug`, `ux`, `copy`, `other`.
- Issue title: `papercut: ` + the first 70 characters of the sentence.
- Body markers: `<!-- papercut-id: <id> -->` and `<!-- papercut-fp: <hex> -->`.
- Only `from:agent` reports are merged by fingerprint. Human reports never are.
- Relay: only `POST` with `Content-Type: text/plain` and no custom headers (no CORS preflight). Origin allowlist `PAPERCUTS_ORIGINS` (default `https://*.lab.t7d.dev`). Repo allowlist `PAPERCUTS_REPOS`.
- CLI exit codes: 0 success and no-op, 1 error, 2 usage error. All structured output is TOON on stdout. stderr carries only progress or debug lines.
- Site: no inline scripts or styles, black and white, plain wording (`DESIGN.md`). Copy the `<head>` with the CSP of an existing page.

## Review Focus

1. A report that contains a secret in the sentence, the element text, the selected text, or a console error must reach GitHub with `[redacted]`. Test in Task 1 (`redacts every free-text field`).
2. The relay is offline, or the Authelia session expired (302 or an HTML answer): the widget must queue the report, not lose it or show success. Test in Task 6 (`queues on redirect`).
3. The same client id sent twice (retry after a timeout) must not create two issues. Test in Task 3 (`same id returns first issue`).
4. A POST from an origin that is not on the list, or for a repo that is not on the list, must not reach GitHub. Test in Task 4 (`rejects foreign origin`, `rejects foreign repo`).
5. A very long sentence or a huge console log must not make an issue body exceed the GitHub limit (65536 chars). Test in Task 1 (`caps body length`).

---

## Part A: the papercuts repo (`~/code/papercuts`, branch `feat/v0.1`)

### Task 1: Format core

**Files:**
- Create: `package.json`, `LICENSE` (MIT, "Copyright (c) 2026 Tim Conrad"), `.gitignore`, `src/format.js`, `test/format.test.js`

**Interfaces:**
- Produces:
  - `KINDS: string[]`, `WIDGET_KINDS: string[]`
  - `redact(text: string): string`
  - `normalizeReport(input: object, from: 'human'|'agent'): {ok: true, report} | {ok: false, error: string, help: string}`. The report has the fields `{id, from, kind, text, where, repo, context}`. `id` is generated (`crypto.randomUUID()`) if missing.
  - `fingerprint(report): string`: sha256 hex, first 16 chars, of `kind|where|normalized text` (lowercase, collapsed whitespace, digits replaced by `#`).
  - `buildIssue(report, {target, project}): {title, body, labels}`
  - `parseMarkers(body: string): {id?: string, fp?: string}`

- [ ] **Step 1: Write the failing tests** (`node:test`, `node:assert/strict`)
  - `redacts every free-text field`: `text`, `context.element.text`, `context.selection`, `context.errors[0]` with `ghp_abcdefgh12345678` → `buildIssue().body` has no `ghp_`, but has `[redacted]`.
  - `keeps disk-usage-report.md`: `redact('disk-usage-report.md') === 'disk-usage-report.md'`.
  - `rejects unknown kind`: `normalizeReport({kind:'nope', text:'x', repo:'a/b'}, 'agent')` → `ok:false`, `help` mentions `bug, ux, copy, tool, rule, path, other`.
  - `rejects empty text` and `rejects bad repo` (`'nope'`, `'a/b/c'`).
  - `title is capped`: an 100-char text → title `papercut: ` + 70 chars.
  - `labels per source`: agent `tool` → `['papercut','from:agent','kind:tool']`. Central target adds `project:a/b`.
  - `fingerprint ignores case, spaces, digits`: `'Port 8000  fails'` and `'port 8080 fails'` give the same fp.
  - `markers round-trip`: `parseMarkers(buildIssue(r).body)` returns `{id: r.id, fp: fingerprint(r)}` for an agent report, and `{id}` with no fp for a human report.
  - `caps body length`: text of 300 chars max (reject above with `ok:false`). A context with 10,000 console errors of 1,000 chars → `body.length <= 60000`, with `(truncated, N chars total)` in it.
- [ ] **Step 2: Run** `node --test` → FAIL (module not found).
- [ ] **Step 3: Implement `src/format.js`.** Port `GEHEIM` from `~/code/pen-and-paper/papercut.py` lines 25-31 as a JS regex with the `gi` flags (the lookbehind works in Node 22). Body layout: the sentence, a blank line, a fenced `yaml` block with `kind`, `from`, `where`, `repo`, and the context (JSON values inline), then the two markers. Limits: text 300, where 120, element text 500, each error 500, errors max 20 (keep the last 20 and add `(N more)`).
- [ ] **Step 4: Run** `node --test` → PASS.
- [ ] **Step 5: Commit** `git add package.json LICENSE .gitignore src/format.js test/format.test.js && git commit -m "Format core: validate, redact, fingerprint, issue body"`

### Task 2: TOON encoder

**Files:** Create `src/toon.js`, `test/toon.test.js`

**Interfaces:**
- Produces: `toon(value: object): string`. It supports scalars (`key: value`), nested objects (indented 2 spaces), arrays of scalars (`key[N]: a,b`), and arrays of uniform objects (`key[N]{f1,f2}:` plus indented rows). Quote a value with JSON when it is empty or contains `,` `"` newline `{` `}` `:` or leading/trailing space (the `feld()` rule of `papercut.py`).

- [ ] **Step 1: Failing tests:** `toon({papercuts:[{id:12,kind:'tool',title:'a, b'}]})` === `'papercuts[1]{id,kind,title}:\n  12,tool,"a, b"'`. `toon({count:'3 of 9 open'})` === `'count: 3 of 9 open'`. `toon({help:['Run `x`']})` === `'help[1]:\n  Run `x`'`. An empty array → `key[0]:`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `"TOON encoder for CLI output"`

### Task 3: Credentials, GitHub client, filing core

**Files:** Create `src/credential.js`, `src/github.js`, `src/file.js`, `test/file.test.js`, `test/fake-github.js`

**Interfaces:**
- Produces:
  - `credentialFrom(config): {token(): Promise<string>, describe(): string}`. Sources: `{source:'gh'}` runs `gh auth token` (execFile, no shell). `{source:'file', path}` reads and trims the file. `{source:'broker', socket}` throws `not implemented in v0.1`. `describe()` never contains the token.
  - `githubClient({credential, apiBase = 'https://api.github.com', fetchImpl = fetch})` with:
    - `listOpen(repo, label)`: up to 300 issues, paged by 100.
    - `listRecent(repo, label, n = 100)`: state `all`, sorted by created.
    - `createIssue(repo, {title, body, labels})` and `comment(repo, n, body)`.
    - `ensureLabels(repo, labels)`: it creates the missing labels, and a 422 "already_exists" counts as success.
    - `close(repo, n, comment)`.

    Errors throw `GithubError {status, message}`. The message never includes headers or the token. The token is only in the `Authorization` header.
  - `fileReport(report, {client, target: {mode:'per-project'|'central', centralRepo?}}): Promise<{ok:true, issue:number, url:string, deduped:boolean, repo:string} | {ok:false, error, help}>`

- [ ] **Step 1: Write `test/fake-github.js`**, an in-memory GitHub on `node:http` (issues, comments, labels, `?state&labels&per_page&page`) that records each request. Then write the failing tests in `test/file.test.js`:
  - `creates issue with labels`: a human report → one issue, labels created, `deduped:false`.
  - `same id returns first issue`: the same report twice → one issue, second result has the same `issue`.
  - `agent repeat adds +1`: two agent reports with the same fp and different ids → one issue, one comment that starts with `+1`, second result `deduped:true`.
  - `human repeat opens new issue`: two human reports with the same text → two issues.
  - `closed fp opens new issue`: an agent repeat after the first issue was closed → a new issue.
  - `central mode`: target central `Tim-Conrad/inbox` → issue in `inbox` with `project:a/b`.
  - `token never in error`: the fake answers 401 → `ok:false`, and the error string does not contain the token value.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Order in `fileReport`:
  1. Run `listRecent` and check for a matching id.
  2. If the report comes from an agent, run `listOpen` and check for a matching fp.
  3. Run `ensureLabels`.
  4. Run `createIssue`.

  Translate each `GithubError` to `{ok:false, error:'github: <status> <short message>', help}`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `"Filing core: id and fingerprint dedupe, credential sources"`

### Task 4: Relay

**Files:** Create `src/config.js`, `src/relay.js`, `test/relay.test.js`

**Interfaces:**
- Consumes: `normalizeReport`, `fileReport`, `githubClient`, `credentialFrom`.
- Produces:
  - `loadConfig(env = process.env): {origins: string[], repos: string[], target, credential, port}`. Env vars: `PAPERCUTS_ORIGINS` (comma list, `*` glob for one label or port), `PAPERCUTS_REPOS` (default `Tim-Conrad/*`), `PAPERCUTS_TARGET` (`per-project`), `PAPERCUTS_CENTRAL_REPO`, `PAPERCUTS_TOKEN_FILE` (then source `file`, else `gh`), `PORT` (8000).
  - `createRelay(config, {client}): http.Server`. Routes:
    - `GET /papercuts.js`: the widget file, with `Cache-Control: no-cache`.
    - `GET /status`: `{ok:true, version, target}` with CORS.
    - `POST /report`: the body is JSON text with `{report, from}`. It answers `{ok, issue, url, deduped}`, or `{ok:false, error, help}` with 400 (bad input), 403 (origin or repo), or 502 (GitHub).
    - `GET /healthz`: `ok`.
- [ ] **Step 1: Failing tests** (real server on port 0, fake GitHub from Task 3):
  - `serves widget no-cache`.
  - `rejects foreign origin`: `Origin: https://evil.example` → 403, fake GitHub got 0 requests.
  - `rejects foreign repo`: repo `someone/else` → 403, 0 requests.
  - `rejects non-text content type`: `application/json` → 415.
  - `cors only for allowed origin`: allowed origin → `Access-Control-Allow-Origin` echoes it and `Access-Control-Allow-Credentials: true`. A disallowed origin → no ACAO header.
  - `files report`: allowed → 200 and an issue exists.
  - `body too large`: more than 256 KB → 413.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `"Relay: widget, status and report routes with origin and repo allowlists"`

### Task 5: AXI CLI

**Files:** Create `bin/papercuts.js` (shebang, `#!/usr/bin/env node`), `src/cli.js`, `src/repo.js`, `test/cli.test.js`. In `package.json`, add `"bin": {"papercuts": "bin/papercuts.js"}`.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `run(argv: string[], {env, cwd, client, stdout}): Promise<number>` (the exit code). `repoFromGit(cwd): string|null` parses `git remote get-url origin` (ssh and https forms).

Commands and their output:
- `papercuts` (home view). Fields, in order:
  - `bin:` (home dir collapsed to `~`) and `description: One place where you and your agents report friction. Each papercut is a GitHub issue.`
  - `repo:` and `papercuts[N]{id,kind,from,title,count}:` for the open papercuts of the current repo. `count` is 1 + the number of `+1` comments.
  - `count: N open (A agent, H human)`.
  - `help[]` with full commands.
  - The empty state: `papercuts: 0 open in <repo>`.
  - Outside a git repo without `--repo`: `error: no repo here` + `help: Run \`papercuts --repo <owner/name>\``, exit 1.
- `papercuts add <kind> "<text>" [--where <place>] [--repo <r>]`: files as `from:agent`. It prints `papercut: #N created` or `papercut: added +1 to #N`.
- `papercuts list [--from agent|human] [--kind k] [--fields a,b] [--repo r]`.
- `papercuts view <id> [--full]`: body cut at 800 chars with `(truncated, N chars total)` and `help: Run \`papercuts view <id> --full\``, only when cut.
- `papercuts done <id> --fix "<what changed>"`: it closes the issue with that comment. If the issue is already closed: `papercut: #N already closed (no-op)`, exit 0.
- `papercuts setup --target per-project|central [--repo r] [--hooks claude,codex]`:
  - It writes `~/.config/papercuts/config.json` (`{target, centralRepo}`).
  - It installs a SessionStart hook that runs `papercuts --hook`, which prints the home view in at most 15 lines, or nothing if 0 are open. It edits `~/.claude/settings.json` (`hooks.SessionStart`) and `~/.codex/config.toml`. If the entry exists, it updates the binary path. Running it twice changes nothing.
  - It prints the token scope for the target.
- `papercuts doctor`: it checks the credential source, the token validity (`GET /user`), and the issue access on the target repo(s). Then it prints the TOON checks and `checks: N/M passed`.
- `papercuts serve`: it starts the relay with `loadConfig`.
- `papercuts skill [--check]`: it writes `skills/papercuts/SKILL.md` from a template plus the current help text. `--check` exits 1 if the file differs.
- `-v`, `-V`, `--version`: the bare version, read before any other import.
- Each subcommand `--help`: flags, defaults, 2-3 examples.
- An unknown flag: `error: unknown flag --x for \`add\`` + `help: valid flags: ...`, exit 2. A missing required argument: exit 2. These checks run before any GitHub call.

- [ ] **Step 1: Failing tests** with the fake GitHub, a temp HOME, and a temp git repo:
  - `home view lists open`, `home empty state`, `add creates then +1`.
  - `done twice is no-op exit 0`, `view truncates with hint`, `view --full no hint`.
  - `unknown flag exit 2 and no request`, `missing text exit 2`, `version fast path`.
  - `setup is idempotent`: run twice → `settings.json` has exactly one papercuts SessionStart entry, and other existing hooks stay.
  - `setup prints scope`.
  - `hook prints nothing when empty`.
  - `skill --check detects drift`.
  - `repoFromGit parses ssh and https`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `"AXI CLI: home, add, list, view, done, setup, doctor, serve, skill"`

### Task 6: Widget and JS API

**Files:** Create `widget/papercuts.js`, `test/browser/page.html`, `test/browser/check_widget.py`

**Interfaces:**
- Consumes: the relay routes from Task 4.
- Produces:
  - Script tag attributes: `src` (the relay origin comes from it), `data-repo` (required), `data-commit`, `data-branch`, `data-storage="k1,k2"`.
  - `window.papercuts`:
    - `.report({kind, text, where?, from?='agent', context?})`: returns `Promise<{ok, issue?, url?, deduped?, queued?, error?, help?}>` and never throws.
    - `.status()`: returns `Promise<{reachable:boolean, queued:number}>`.
    - `.open()`
  - `window.papercutsContext?()` is merged into the context when the site defines it.

Behavior:
- It installs the `error` and `unhandledrejection` listeners at once (with a 20-entry ring buffer).
- It calls `GET /status` with credentials. If the call fails, it renders nothing and keeps the API.
- The UI is a Shadow DOM host with a tab on the right edge (`Papercut`). It has these steps:
  1. "Pick" mode: hover outlines the element, a tap selects it, and "Parent" goes up a level. "Whole view" takes the full view.
  2. A kind select (`bug`, `ux`, `copy`, `other`).
  3. A textarea with a 300-char counter, and Send.
- The context holds the URL, title, viewport, dpr, UA, theme, scroll, and selection. For the element, it holds the CSS path, text, `data-*` of the element and its parents, and the bounding box.
- It sends `fetch(relay + '/report', {method:'POST', credentials:'include', headers:{'Content-Type':'text/plain'}, body: JSON.stringify({report, from})})`.
- These cases count as "not delivered": a network error, `res.redirected`, `res.type === 'opaqueredirect'`, a non-JSON answer, or a 502. Then the report goes into the IndexedDB queue `papercuts-queue-v1`. It retries on `online`, on `visibilitychange` to visible, and every 60 s. A redirect shows "Log in again at lab.t7d.dev" in the tab.
- Keyboard: `Alt+Shift+P` opens the widget.

- [ ] **Step 1: Write the browser check** `test/browser/check_widget.py` (playwright). It starts `node bin/papercuts.js serve` against the fake GitHub on a free port, then serves `page.html`. Checks at 412 px and 1440 px:
  - `tab visible`, `pick and send creates issue`.
  - `api report returns issue`.
  - `api report agent repeat deduped`.
  - `no tab when relay down` (the API returns `{ok:false, queued:true}`).
  - `queues on redirect`: the relay test mode answers 302 → the report is queued. After the relay is back, it is sent.
  - `no console errors`, `no horizontal scroll`.
  - `host css does not leak`: the page sets `* {color:red !important}`, and the widget text stays its own color.
- [ ] **Step 2: Run** `uv run --no-project --with playwright python3 test/browser/check_widget.py` → FAIL.
- [ ] **Step 3: Implement.** Add a test-only env var `PAPERCUTS_TEST_REDIRECT=1` in the relay, so that `/report` answers 302.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `"Widget and JS API with offline queue"`

### Task 7: Docs, skill, container, release prep

**Files:**
- Create: `README.md`, `AGENTS.md` (snippet for projects), `skills/papercuts/SKILL.md` (via `papercuts skill`), `Dockerfile` (`node:22-alpine`, non-root `node` user, `CMD ["node","bin/papercuts.js","serve"]`), `docker-compose.example.yml` (the canonical lab compose with `papercuts.lab.t7d.dev`, `secrets: github-token` file `./secrets/github-token`, `PAPERCUTS_TOKEN_FILE=/run/secrets/github-token`, `mem_limit: 128m`), `.github/workflows/test.yml` (`node --test` and `node bin/papercuts.js skill --check` on Node 22).
- Test: none new (docs and config).

README sections, in order (STE):
1. What it is (two sentences).
2. Why.
3. Quick start for a site.
4. Quick start for an agent.
5. Setup: target and token scope.
6. Run the relay (lab and localhost).
7. Issue format.
8. Security.
9. Agent experience (AXI).
10. License.

The README must work standalone when it is rendered on t7d.dev:
- Only absolute links.
- No raw HTML.
- No relative images.

- [ ] **Step 1:** Write the files. Run `node bin/papercuts.js skill`.
- [ ] **Step 2:** Run `node --test && node bin/papercuts.js skill --check && docker build -t papercuts:test .` → all pass.
- [ ] **Step 3:** Run `docker run --rm -e PAPERCUTS_REPOS='Tim-Conrad/*' papercuts:test node bin/papercuts.js --version` → `0.1.0`.
- [ ] **Step 4: Commit** `"README, agent snippet and skill, container, CI"`

### Task 8: Publish (needs Tim's OK, it is public)

- [ ] **Step 1:** Ask Tim to confirm the public repo.
- [ ] **Step 2:** Merge `feat/v0.1` into `main` locally. Run `gh repo create Tim-Conrad/papercuts --public --source . --push --description "One place where you and your agents report friction. Each papercut is a GitHub issue."`.
- [ ] **Step 3:** Live check with Tim's `gh` login:
  1. `papercuts add other "live check, close me" --repo Tim-Conrad/papercuts` → an issue exists with 3 labels.
  2. The same command again → `added +1`.
  3. `papercuts done <id> --fix "live check"` → closed.
- [ ] **Step 4:** Run `git tag v0.1.0 && git push origin v0.1.0` and `gh release create v0.1.0 --generate-notes`.

## Part B: t7d.dev (`~/code/Tim-Conrad.github.io`, branch `feat/tools-papercuts`)

### Task 9: Move the script folder `tools/` to `scripts/`

**Files:**
- `git mv tools scripts`.
- Modify: `.github/workflows/deploy.yml:24`, `docker-compose.dev.yml:1,17`, `README.md`, `CLAUDE.md`, `.claude/skills/updating-game-timeline/SKILL.md`, `.gitignore` comment, and every `tools/` path inside `scripts/*.sh|*.py|*.mjs`. Find them with `grep -rn 'tools/' --exclude-dir=node_modules --exclude-dir=.git .`.

- [ ] **Step 1:** Do the move and the edits.
- [ ] **Step 2:** Run `grep -rn 'tools/' --exclude-dir=node_modules --exclude-dir=.git .` → only paths that are not about the scripts (none expected yet).
- [ ] **Step 3:** Run `python3 -m unittest scripts/review/test_devserver.py` → OK.
- [ ] **Step 4:** Run `bash -n scripts/deploy.sh scripts/ship.sh` → OK.
- [ ] **Step 5:** Commit `"Move the scripts from tools/ to scripts/, so that /tools/ can be a page"`

### Task 10: Tools sheet and the papercuts page

**Files:**
- Create: `tools/tools.json` (`[{"slug":"papercuts","name":"Papercuts","repo":"Tim-Conrad/papercuts","description":"..."}]`), `tools/index.html`, `tools/papercuts/index.html`, `scripts/gen-tools.py`, `scripts/test_gen_tools.py`
- Modify: `index.html` (new »Tools« sheet after Research, renumber the sheets after it, update "Contents"), `scripts/deploy.sh` (add `tools` to `SITE`, run `gen-tools.py` on the published copy after `gen-feeds.py`), `.github/workflows/deploy.yml` (step `pip install markdown==3.11.3` before deploy), `sitemap.xml` (`/tools/`, `/tools/papercuts/`), `assets/site.css` only if the README markup needs styles (code blocks, tables).

**Interfaces:**
- `gen-tools.py [<site folder>] [--readme-dir <dir>]`. For each tool:
  1. Fetch the latest release tag (`GET https://api.github.com/repos/<repo>/releases/latest`).
  2. Fetch the README at that tag from `raw.githubusercontent.com`.
  3. Render it with `markdown.markdown(text, extensions=['fenced_code','tables'])`.
  4. Replace `<!-- tool-readme -->` in `tools/<slug>/index.html`.

  It also fills `<!-- tools-list -->` in `index.html` and `tools/index.html` from `tools.json`. `--readme-dir` reads `<slug>.md` locally (for tests and the review site). If a fetch fails, it exits 1 with `error: ...` (the deploy fails loud). It removes any raw HTML block tags from the rendered output, so that the CSP stays strict.
- The intro paragraphs in `tools/papercuts/index.html` are in Tim's voice, plain (DESIGN.md). Give the facts only: the three copies it replaces, the one place, local sites only.

- [ ] **Step 1: Failing tests** (`unittest`, a temp site copy, `--readme-dir`):
  - `fills readme placeholder`.
  - `fills tools list on front page and index`.
  - `strips raw html and script`.
  - `missing readme exits 1`.
- [ ] **Step 2: Run** `python3 -m unittest scripts/test_gen_tools.py` → FAIL.
- [ ] **Step 3: Implement** and write the pages.
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Look at the pages.** Run `python3 scripts/gen-tools.py <copy> --readme-dir ~/code/papercuts` on a temp copy and serve it. Look at `/`, `/tools/`, `/tools/papercuts/` at 1440, 390, 320 px, light and dark:
  - no sideways scroll
  - no console errors
  - no CSP violations
- [ ] **Step 6: Commit** `"Tools sheet and the papercuts page, README rendered at deploy"`

### Task 11: Draft page: credential broker (never published)

**Files:**
- Modify: `.gitignore` (add `/drafts/`), `CLAUDE.md` (one line: `drafts/` is local only, gitignored, never in `SITE` or `sitemap.xml`. The repo is public.)
- Create (local, untracked): `drafts/credential-broker/index.html`

Content: Tim's idea and Claude's correction, as a draft thought:
- The problem: an info stealer reads tokens that lie on the host.
- Why injection into a signed process does not help on Linux: same uid, `/proc/<pid>/environ`, ptrace, `LD_PRELOAD`, no signature check, `docker` group = root.
- The idea: give out a capability, not the credential. A broker under its own uid holds the credential, encrypted at rest, unlocked at boot. It does narrow actions on a Unix socket, with per-caller rules, a rate limit, and an audit log. Risky actions need phone approval. It stores a GitHub App key and creates 1-hour tokens for one repo.
- What is left: abuse within the rules.
- Clients: papercuts (the `broker` credential seam), `gh`, Cloudflare, Tripo.
- Mark it "Draft. Not published."

Add `<meta name="robots" content="noindex">`.

- [ ] **Step 1:** Write the page and the two edits.
- [ ] **Step 2:** Run `git status --short` → `drafts/` does not appear. Run `git check-ignore drafts/credential-broker/index.html` → it prints the path.
- [ ] **Step 3:** Look at the page on the local server at 390 and 1440 px.
- [ ] **Step 4:** Commit `.gitignore` and `CLAUDE.md` only: `"Local drafts folder, never published"`

### Task 12: PR for the site

- [ ] **Step 1:** Follow the `visual-pr` skill. Take Before and After screenshots of the front page (the new sheet) and screenshots of `/tools/papercuts/`.
- [ ] **Step 2:** Push the branch and open the PR. The deploy needs the `v0.1.0` release of papercuts from Task 8.
