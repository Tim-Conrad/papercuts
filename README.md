# Papercuts

Papercuts is one place where you and your agents report friction. Each papercut becomes a GitHub issue in the repo of the project, or a row in a gitignored SQLite file of the repo (the local store).

## Why

Small problems get lost. A button overlaps on the phone. A tool prints output that an agent cannot use. A rule in `AGENTS.md` points to a file that moved. Each one costs a few minutes, again and again.

Papercuts gives people and agents the same short path to report them. All reports land in the same place, in the same format. The agent that picks up the work reads them all the same way. The result is a steady flow of small fixes.

Papercuts is for local sites: dev and review copies on your own machine or home lab. It is not a feedback widget for public visitors.

## The parts

- **Widget.** A tab on the edge of a page. People only give feedback: one input, by voice or by text, then Send. Agents triage it, so people choose no kind and fill no fields. Everything else comes along in the background: the element that you touched last, the URL, the place, the viewport, the selected text and the console errors. "Mark" adds more: numbered elements, boxes around regions, and drawings on a picture or a screen picture. The panel also lists the open papercuts of the repo with their replies, and the ones fixed in the last 14 days with the fix note.
- **JS API.** An agent that drives a browser calls `papercuts.report()` on the same page. It does not need to click the tab.
- **CLI.** An agent in a terminal runs `papercuts add tool "..."`. The output follows the [AXI](https://axi.md) rules for agent tools.
- **Relay.** A small server that holds the GitHub credential, serves the widget, and creates the issues. The browser never sees a token.

Papercuts has no runtime dependencies. It needs Node.js 22.13 or later (the local store uses the built-in `node:sqlite`).

## Integrate papercuts into an app

This checklist is for the agent or person who adds papercuts to an app. Do the steps in this order:

1. In the repo of the app, run `papercuts init`, or `papercuts init --store local` for the local store (see [Where papercuts go](#where-papercuts-go)). It detects the stack, writes `.github/papercuts.json` and the papercuts block in `AGENTS.md`, and prints the exact steps for your stack.
2. Add the script tag on the server, only when `PAPERCUTS_URL` is set (see [Load papercuts only where a relay exists](#load-papercuts-only-where-a-relay-exists)).
3. Add a test: without `PAPERCUTS_URL` the page has no `papercuts`, with it the page has exactly one tag.
4. Set `PAPERCUTS_URL` only for the copies with a relay, for example the lab and dev copies.
5. Edit `.github/papercuts.json`: the kinds, the fields, the quick phrases and the labels of this app (see [The ticket config](#the-ticket-config)).
6. Run `papercuts config --file .github/papercuts.json --check` before the push, and `papercuts config --check` after it. Both exit 1 on a warning.

## Quick start: a site

First, run a relay (see [Run the relay](#run-the-relay)). Then add one tag to the `<head>` of the page. Put it early, so that the widget sees console errors from the start:

```html
<script src="https://papercuts.lab.example.com/papercuts.js" data-repo="owner/name"></script>
```

Load the page. The tab "Papercut" shows at the right edge. The keyboard shortcut is `Alt+Shift+P`. `Ctrl+Enter` sends. You can drag the tab up or down, and the page keeps the position.

If the relay does not answer, the page shows no tab.

Optional attributes on the script tag:

| Attribute | Use |
| --- | --- |
| `data-repo` | Required. The repo for the issues, as `owner/name`. |
| `data-lang` | The language of the widget: `en` (default), `de`, or a language that the site adds (see below). The JS API answers in English. |
| `data-speech-lang` | The language for speech input, for example `de-DE`. Default: the `lang` of the page. |
| `data-commit`, `data-branch` | The version of the site. The issue shows them. |
| `data-storage` | A comma list of `localStorage` keys to include, or `*` for all keys (at most 50). By default the widget sends no `localStorage`, because it can hold tokens or private data. |
| `data-storage-skip` | With `data-storage="*"`: a comma list of keys to leave out, for example a room code. |
| `data-mode` | `download`: see [Without a relay](#without-a-relay). |
| `data-accent` | The accent color of the widget, any CSS color. Default: a coral red. |
| `data-shortcut` | The key combination that opens the panel. Default `alt+shift+p`. `off` turns it off. |
| `data-gesture` | `off` turns off the two-finger long press on touch screens. |
| `data-voice` | `off` turns off voice first on touch screens. |

Hooks for the page:

- `window.papercutsContext = (el) => ({ openCard: "c12" })` adds your own fields to each report. `el` is the first marked element, or `null`.
- `window.papercutsHidden = () => true` hides the tab, for example in a print view or a kiosk mode. The widget asks once per second.
- `window.papercutsReplay = () => [{ click: '.card[data-id="k12"]' }]` records up to five clicks that bring the page back to the reported state, for example a dialog without a URL. `papercuts replay` runs them.
- `window.papercutsStrings = { fr: { send: "Envoyer", close: "Fermer" } }` adds or changes the words of a language. A missing word falls back to English. Set it before the page finishes loading. The keys are in the table `T` at the top of `widget/papercuts.js`.

In a modal `<dialog>` or in fullscreen, the widget moves into the dialog or the fullscreen element, so that it stays usable.

### Mark parts of the page

The element that you touched last, in the 15 seconds before you open the panel, is attached by itself. "Mark" opens the live page with a toolbar at the bottom:

- **Tap** marks an element. A second tap removes the mark. Larger and Smaller move the newest mark to its parent and back.
- **Box** marks a region: drag a box around it.
- **Draw** opens a picture of the page in the drawing sheet: pen and numbered pins.

Each mark gets a number on the page and a row in the panel, with an optional note. The issue lists the marks, and `papercuts replay` frames each one with its number.

### Load papercuts only where a relay exists

Do not put the tag into a published copy of a site. A published copy has no relay, and the tag shows the relay URL to every visitor. Add the tag on the server, and only when an environment variable is set:

```python
# FastAPI: build index.html yourself when PAPERCUTS_URL is set.
# Do not use FileResponse for it: its 304 keeps a cached copy without the tag.
html = INDEX.read_text()
if url := os.environ.get("PAPERCUTS_URL"):
    html = html.replace("</head>", f'<script src="{url}/papercuts.js" data-repo="owner/name"></script></head>', 1)
return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
```

```nginx
# nginx: a template under /etc/nginx/templates/ (the official image fills in ${PAPERCUTS_URL})
sub_filter '</head>' '<script src="${PAPERCUTS_URL}/papercuts.js" data-repo="owner/name"></script></head>';
sub_filter_once on;
```

For nginx, use two config files and let the entrypoint choose one, so that no tag goes out when the variable is empty. For a static build (Vite), add the tag when the server delivers the page, not at build time, so that one build works with and without papercuts.

### Shortcuts for people

- **Keys.** `Alt+Shift+P` opens and closes the panel. Change it with `data-shortcut`, for example `data-shortcut="ctrl+k"`.
- **A link.** A URL with `#papercut` (or `?papercut=open`) opens the panel when the page loads. Use it for a bookmark, a QR code or a home-screen icon. The widget removes it from the URL.
- **Two fingers.** On a touch screen, hold two fingers on the page for 0.6 seconds.
- **Quick phrases.** The `presets` of the ticket config show as chips. One tap fills the kind and the sentence.
- **Your own button.** `papercuts.open({ text: "...", kind: "idea", marks: ["#cart", element], fields: { ... } })` opens the panel with a draft, for a menu entry of the app. Every key is optional. `marks` takes elements or CSS selectors.

### Voice input

On a touch screen with speech input, a large "Tap to speak" button leads the panel. The words show while you speak, and you can edit them. On desktop, the microphone is a small button in the text field. Speech uses `data-speech-lang`, else the `lang` of the page. Without speech input in the browser, the panel leads with the text field.

### Without a relay

With `?papercuts=download` in the URL, or `data-mode="download"`, the widget shows the tab without a relay. Send becomes "Download report" and saves the report as a JSON file. File it later with `papercuts import <file>`. For this mode, serve a copy of `widget/papercuts.js` from the site itself.

## The ticket config

`.github/papercuts.json` in the repo of the app defines what a papercut of this app contains. The relay reads it from the default branch (cached for 5 minutes) and applies it to reports from the widget, the JS API and the CLI. Every key is optional. Without the file, the defaults apply.

```json
{
  "$schema": "https://raw.githubusercontent.com/Tim-Conrad/papercuts/main/schema/papercuts.schema.json",
  "kinds": ["bug", "ux", "copy", "idea"],
  "fields": [
    { "id": "expected", "label": "What did you expect?", "required": true },
    { "id": "device", "label": "Device", "options": ["phone", "tablet", "desktop"] }
  ],
  "presets": [{ "kind": "ux", "text": "Too small to tap" }],
  "labels": ["area:web"],
  "labelsByKind": { "bug": ["bug"] },
  "assignees": ["your-login"],
  "context": { "storage": ["theme"], "skipStorage": ["room-code"] },
  "lang": "en"
}
```

| Key | Use |
| --- | --- |
| `kinds` | The kinds that agents use in this repo. Use the built-in kinds only, so that labels stay the same in all repos. |
| `fields` | At most 8 extra fields for agents. A field with `options` is a choice, else one line of text. A required field is required for agent reports. A field with `kinds` belongs to those kinds only, for example `{ "id": "severity", "label": "Severity", "options": ["low", "high"], "kinds": ["bug"] }`. People never see the fields. `open({ fields })` can fill them for a person. |
| `presets` | At most 12 quick phrases for the widget. One tap fills the sentence and, silently, the kind. |
| `labels`, `labelsByKind`, `assignees` | Added to each new issue. |
| `context` | The `localStorage` keys to include, the same as `data-storage` and `data-storage-skip`. |
| `lang` | The language of the widget when the page sets no `data-lang`. |
| `store` | `github` (default) or `local`. See [Where papercuts go](#where-papercuts-go). |

A broken part never breaks the page or a report. The relay drops it, uses the default, and lists a warning. `papercuts config` shows the warnings. The schema in `schema/papercuts.schema.json` lets an editor check the file. Page attributes win over the file.

Agents fill the fields with `papercuts add <kind> "<text>" --field expected="..."`, and pages with `papercuts.report({ ..., fields: { expected: "..." } })`. An unknown field or a missing required field gives an error with the list of valid fields.

## Quick start: an agent

In a terminal:

```sh
npx github:Tim-Conrad/papercuts add tool "gh-axi pr view drops the PR body" --where "gh-axi pr view"
npx github:Tim-Conrad/papercuts            # the open papercuts of this repo
npx github:Tim-Conrad/papercuts view 12
npx github:Tim-Conrad/papercuts shot 12    # save the picture of #12 as a PNG
npx github:Tim-Conrad/papercuts replay 12  # show the page as the reporter saw it
npx github:Tim-Conrad/papercuts comment 12 "Option A: ... Option B: ..."
npx github:Tim-Conrad/papercuts done 12 --fix "gh-axi prints the body since commit abc1234"
npx github:Tim-Conrad/papercuts config     # the ticket config of this repo
npx github:Tim-Conrad/papercuts init       # set up papercuts in the repo of an app
```

The CLI uses the `gh` login of the host, or the token file of `papercuts setup`. It finds the repo from the git remote `origin`, or from `--repo owner/name`.

`replay` opens the URL of the report with the same viewport, hash, scroll position and `localStorage` keys, frames the element in red, and writes a PNG. It runs Playwright through [uv](https://docs.astral.sh/uv/). Without `uv`, it prints the replay data, so that an agent can drive its own browser. Use `--base <url>` to open the same page on another host, for example a dev copy without login.

In a browser, on a page with the widget:

```js
if (window.papercuts) {
  await papercuts.report({ kind: "ux", text: "The save button is under the keyboard at 412 px", where: "/settings" });
}
```

`report()` takes `kind`, `text`, `where`, `fields`, `marks` and `from` (`"agent"` by default, `"human"` for a report that a person wrote in the app's own form). `report()` never throws. It returns `{ ok, issue, url, deduped }`, or `{ ok: false, error, help, queued }`. A report that the relay cannot take now waits in the browser (IndexedDB) and goes out later. The browser removes known secret patterns before it stores a report.

The repo includes a skill for agents (`skills/papercuts/SKILL.md`). The file `AGENTS.md` holds a block to copy into the `AGENTS.md` of a project.

## Setup

Run `papercuts setup` once per machine. It writes `~/.config/papercuts/config.json` and installs a session-start hook for Claude Code and Codex. The hook shows the open papercuts of the current repo at the start of each agent session, and nothing when there are none. The hook calls `papercuts` from the `PATH` first, so that a Node.js upgrade does not break it.

### Where papercuts go

Each repo chooses its store when you integrate papercuts:

| Store | Command | Where papercuts go |
| --- | --- | --- |
| GitHub (default) | `papercuts init` | GitHub issues, see the targets below |
| Local | `papercuts init --store local` | `.papercuts/papercuts.db`, a SQLite file in the main checkout. `init` adds `.papercuts/` to `.gitignore`. |

The local store needs no GitHub account, no credential and no network. Use it for a project without a GitHub remote, for private notes that must not become issues, or offline. `init --store local` writes `"store": "local"` into `.github/papercuts.json`. All commands then read and write the local file: `add`, the home view, the session hook, `list`, `view`, `comment`, `done`, `shot` and `doctor`. A git worktree uses the file of its main checkout. Pictures go to `.papercuts/shots/`. `PAPERCUTS_STORE=github|local` overrides the setting for one command. A `--repo` for another repo always goes to GitHub.

For the widget, start a local relay in the repo folder: `PORT=8787 papercuts serve`. With the local store, the relay accepts the origins `http://localhost:*` and `http://127.0.0.1:*` and any repo name by default. Set `PAPERCUTS_URL=http://localhost:8787` for the dev server.

For the GitHub store, `papercuts setup` chooses the target:

| Target | Command | Where issues go |
| --- | --- | --- |
| Per project | `papercuts setup --target per-project` | The repo of the page or of the git remote |
| Central | `papercuts setup --target central --repo owner/papercuts-inbox` | One inbox repo. The label `project:owner/name` keeps the source. |

### The credential

| Credential | Command | Scope | Pictures |
| --- | --- | --- | --- |
| `gh` login (default) | `papercuts setup --target per-project` | All scopes of your `gh` login | Upload into the issue |
| Fine-grained token | `papercuts setup --target per-project --credential file --token-file <path>` | "Issues: read and write" and "Contents: read" (for the ticket config), only the repos you choose | GitHub refuses them. The relay keeps them and the issue links to them. |

The `gh` login works at once. Its token usually has the scopes `repo` and `workflow`, which is much more than papercuts needs. If an attacker takes over the relay, the attacker can do everything that the token allows. Use a fine-grained token if that risk is too high for you.

Run `papercuts doctor` to check the credential and the access.

## Run the relay

The relay reads its settings from the environment:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8000` | The port of the relay. |
| `PAPERCUTS_STORE` | the `store` of `.github/papercuts.json` in the folder, else `github` | `github` or `local`. |
| `PAPERCUTS_HOST` | `0.0.0.0`, local store: `127.0.0.1` | The address that the relay listens on. |
| `PAPERCUTS_DB` | `.papercuts/papercuts.db` of the main checkout | The SQLite file of the local store. |
| `PAPERCUTS_ORIGINS` | `https://*.lab.t7d.dev`, local store: `http://localhost:*,http://127.0.0.1:*` | Sites that can send reports and read the list. `*` matches one host label or one port. |
| `PAPERCUTS_REPOS` | `Tim-Conrad/*`, local store: `*/*` | Repos that can receive issues. |
| `PAPERCUTS_TARGET` | `per-project` | `per-project` or `central`. |
| `PAPERCUTS_CENTRAL_REPO` | none | The inbox repo for the central target. |
| `PAPERCUTS_CREDENTIAL` | `gh`, or `file` if a token file is set | `gh` or `file`. |
| `PAPERCUTS_TOKEN_FILE` | none | A file with a fine-grained token. |
| `PAPERCUTS_GITHUB_HOST` | `github.com` | Another GitHub host: GitHub Enterprise Server, or a gateway that adds the token (the dev VM's `gh.gate`). The API is then `https://<host>/api/v3`, uploads `https://<host>/api/uploads`, and the gh credential asks for the login of that host. |
| `PAPERCUTS_GH_MOUNT` | none | A read-only folder with the `gh` login (`config.yml`, `hosts.yml`). The relay gives `gh` a private copy in its temp folder before each call. |
| `PAPERCUTS_PUBLIC_URL` | none | The public URL of the relay, for the links to pictures that GitHub refused. |
| `PAPERCUTS_SHOTS_DIR` | `shots` | The folder for those pictures. |
| `PAPERCUTS_LIST_CACHE_MS` | `30000` | How long the relay keeps the list of open papercuts per repo. |
| `PAPERCUTS_CONFIG_CACHE_MS` | `300000` | How long the relay keeps the ticket config per repo. |

On a laptop, for sites on `localhost`:

```sh
PAPERCUTS_ORIGINS="http://localhost:*" PAPERCUTS_REPOS="owner/*" npx github:Tim-Conrad/papercuts serve
```

Then use `http://localhost:8000/papercuts.js` in the script tag.

In a home lab, run the container behind your single sign-on proxy. `docker-compose.yml` shows the setup of the author with Traefik and Authelia. It mounts `~/.config/gh` read-only and runs the container as the user that owns it, because `gh` keeps `hosts.yml` with mode 600. Change the host names, the origins, the repos and the user ID for your lab.

The widget sends only simple requests: `POST` with `Content-Type: text/plain` and no custom headers. Browsers then send no CORS preflight. A login proxy can therefore stay in front of every route of the relay. The session cookie of the proxy must cover the domain of the site and of the relay. If the login expired, the widget keeps the report and asks you to log in again.

Routes:

| Route | Use |
| --- | --- |
| `GET /papercuts.js` | The widget. |
| `POST /report` | File one report (max 12 MB with a picture). |
| `GET /list?repo=owner/name` | The open papercuts and the ones closed in the last 14 days, with replies, fix note and place. A browser must come from an allowed origin. |
| `GET /config?repo=owner/name` | The checked ticket config of the repo, with warnings. A browser must come from an allowed origin. |
| `GET /shots/<id>.png` | A picture that GitHub refused. |
| `GET /status`, `GET /healthz` | Health. |

`papercuts shot` reads relay pictures from `PAPERCUTS_RELAY_INTERNAL` if you set it, for example the address of the container on the Docker network. Otherwise it uses the public link.

## Issue format

- Title: `papercut: ` and the first 70 characters of the sentence.
- Labels: `papercut`, `from:human` or `from:agent`, and `kind:<kind>`. The central target adds `project:<owner/name>`.
- Kinds: `bug`, `ux`, `copy`, `tool`, `rule`, `path`, `idea`, `other`. People choose no kind: a report from the widget is `other`, unless a preset or `open()` sets one. Agents choose the kind.
- Body: the sentence, the picture and the numbered pins if there are any, a YAML block with the context, and HTML comments: `papercut-id` (one per report), `papercut-place` (where the reporter was), and for agents `papercut-fp` (the fingerprint).

Repeats:

- A report with an ID that exists already returns the first issue. A retry therefore never makes a second issue. This also holds in the first seconds, before GitHub lists a new issue.
- A report from an agent with the same kind, place and sentence as an open papercut adds a `+1` comment to that issue. Digits, case and spaces do not change the fingerprint.
- A report from a person always opens a new issue.

## Security

- The token stays on the relay or in the `gh` login of the host. It never goes to the browser, into an issue, into a log, or into a command line. `papercuts shot` sends it only to `github.com`.
- Papercuts replaces known secret patterns with `[redacted]` before a report leaves the browser or the machine. Examples are GitHub tokens, `Bearer` values, AWS keys, and `password=...`. The relay does it again. This catches common mistakes. It does not find every secret.
- The relay accepts reports only from the origins in `PAPERCUTS_ORIGINS`, and only for the repos in `PAPERCUTS_REPOS`. A report without an `Origin` header gets a 403. A browser from another origin cannot read the list.
- The relay has no login of its own. Run it behind a login proxy, and do not expose it on a network that you do not trust.
- The widget sends no `localStorage` unless the site names the keys.
- Do not load papercuts on a page that shows decrypted or secret content. A report copies the text of the picked element and can include a picture of the page.
- A token file on the host is still readable by any program of the same user. A later version adds a credential source that asks a separate broker process to do the call, so that the token never leaves it.

## Agent experience (AXI)

The CLI follows the ten [AXI](https://axi.md) principles:

- Output is TOON on stdout.
- `papercuts` with no arguments shows the open papercuts.
- Lists carry counts, and empty results say what is empty.
- Long bodies are cut, with the total size and a `--full` hint.
- Each error has a `help:` line with the command that fixes it.
- Exit codes: `0` success (also a no-op), `1` error, `2` usage error.
- An unknown flag fails at once, before any network call.
- Each command has `--help` with examples. `--version` prints the version.

## Develop

```sh
npm test                 # unit tests (node:test)
npm run check:browser    # browser check of the widget (Playwright through uv)
node bin/papercuts.js skill --check
```

## License

MIT. See [LICENSE](https://github.com/Tim-Conrad/papercuts/blob/main/LICENSE).

## Development (dev VM)

- `direnv allow` (or `nix develop`) loads the tools from `flake.nix`. Python packages go into `.venv` from the repo's own pins.
- Tests: `npm test`.
- `wt up` starts the preview of this checkout or worktree: `https://<branch>--papercuts.review.t7d.dev`. `https://papercuts.review.t7d.dev` shows the current worktree (`wt switch <branch>`), and `https://review.t7d.dev` lists all previews.
- The relay of this worktree with a local store in .preview/ (no GitHub issues). Status page: /status.
- `wt new <branch>` makes a worktree, `wt ls` lists them, `wt rm <branch>` removes one. The preview is defined in `compose.preview.yml`.
