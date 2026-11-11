# Papercuts

Papercuts is one place where you and your agents report friction. Each papercut becomes a GitHub issue in the repo of the project.

## Why

Small problems get lost. A button overlaps on the phone. A tool prints output that an agent cannot use. A rule in `AGENTS.md` points to a file that moved. Each one costs a few minutes, again and again.

Papercuts gives people and agents the same short path to report them. All reports land in the same place, in the same format. The agent that picks up the work reads them all the same way. The result is a steady flow of small fixes.

Papercuts is for local sites: dev and review copies on your own machine or home lab. It is not a feedback widget for public visitors.

## The parts

- **Widget.** A tab on the edge of a page. You pick the part of the page that you mean, write one sentence, and send. You can mark a picture or a screen picture with a pen and numbered pins. The widget adds the context: the URL, the viewport, the element, the selected text, and the console errors. The panel also lists the open papercuts of the repo with their replies, and the ones fixed in the last 14 days with the fix note.
- **JS API.** An agent that drives a browser calls `papercuts.report()` on the same page. It does not need to click the tab.
- **CLI.** An agent in a terminal runs `papercuts add tool "..."`. The output follows the [AXI](https://axi.md) rules for agent tools.
- **Relay.** A small server that holds the GitHub credential, serves the widget, and creates the issues. The browser never sees a token.

Papercuts has no runtime dependencies. It needs Node.js 22 or later.

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

Hooks for the page:

- `window.papercutsContext = () => ({ openCard: "c12" })` adds your own fields to each report.
- `window.papercutsHidden = () => true` hides the tab, for example in a print view or a kiosk mode. The widget asks once per second.
- `window.papercutsReplay = () => [{ click: '.card[data-id="k12"]' }]` records up to five clicks that bring the page back to the reported state, for example a dialog without a URL. `papercuts replay` runs them.
- `window.papercutsStrings = { fr: { send: "Envoyer", close: "Fermer" } }` adds or changes the words of a language. A missing word falls back to English. Set it before the page finishes loading. The keys are in the table `T` at the top of `widget/papercuts.js`.

In a modal `<dialog>` or in fullscreen, the widget moves into the dialog or the fullscreen element, so that it stays usable. After "Parent", "Smaller" goes back down to the element that you picked.

### Load papercuts only where a relay exists

Do not put the tag into a published copy of a site. A published copy has no relay, and the tag shows the relay URL to every visitor. Add the tag on the server, and only when an environment variable is set:

```python
# FastAPI: add the tag only when PAPERCUTS_URL is set
html = INDEX.read_text()
if url := os.environ.get("PAPERCUTS_URL"):
    html = html.replace("</head>", f'<script src="{url}/papercuts.js" data-repo="owner/name"></script></head>', 1)
```

```nginx
# nginx: a template under /etc/nginx/templates/ (the official image fills in ${PAPERCUTS_URL})
sub_filter '</head>' '<script src="${PAPERCUTS_URL}/papercuts.js" data-repo="owner/name"></script></head>';
sub_filter_once on;
```

For nginx, use two config files and let the entrypoint choose one, so that no tag goes out when the variable is empty. For a static build (Vite), add the tag when the server delivers the page, not at build time, so that one build works with and without papercuts.

### Without a relay

With `?papercuts=download` in the URL, or `data-mode="download"`, the widget shows the tab without a relay. Send becomes "Download report" and saves the report as a JSON file. File it later with `papercuts import <file>`. For this mode, serve a copy of `widget/papercuts.js` from the site itself.

## Quick start: an agent

In a terminal:

```sh
npx github:Tim-Conrad/papercuts add tool "gh-axi pr view drops the PR body" --where "gh-axi pr view"
npx github:Tim-Conrad/papercuts            # the open papercuts of this repo
npx github:Tim-Conrad/papercuts view 12
npx github:Tim-Conrad/papercuts shot 12    # save the picture of #12 as a PNG
npx github:Tim-Conrad/papercuts replay 12  # show the page as the reporter saw it
npx github:Tim-Conrad/papercuts done 12 --fix "gh-axi prints the body since commit abc1234"
```

The CLI uses the `gh` login of the host, or the token file of `papercuts setup`. It finds the repo from the git remote `origin`, or from `--repo owner/name`.

`replay` opens the URL of the report with the same viewport, hash, scroll position and `localStorage` keys, frames the element in red, and writes a PNG. It runs Playwright through [uv](https://docs.astral.sh/uv/). Without `uv`, it prints the replay data, so that an agent can drive its own browser. Use `--base <url>` to open the same page on another host, for example a dev copy without login.

In a browser, on a page with the widget:

```js
if (window.papercuts) {
  await papercuts.report({ kind: "ux", text: "The save button is under the keyboard at 412 px", where: "/settings" });
}
```

`report()` never throws. It returns `{ ok, issue, url, deduped }`, or `{ ok: false, error, help, queued }`. A report that the relay cannot take now waits in the browser (IndexedDB) and goes out later. The browser removes known secret patterns before it stores a report.

The repo includes a skill for agents (`skills/papercuts/SKILL.md`). The file `AGENTS.md` holds a block to copy into the `AGENTS.md` of a project.

## Setup

Run `papercuts setup` once per machine. It writes `~/.config/papercuts/config.json` and installs a session-start hook for Claude Code and Codex. The hook shows the open papercuts of the current repo at the start of each agent session, and nothing when there are none. The hook calls `papercuts` from the `PATH` first, so that a Node.js upgrade does not break it.

### Where papercuts go

| Target | Command | Where issues go |
| --- | --- | --- |
| Per project | `papercuts setup --target per-project` | The repo of the page or of the git remote |
| Central | `papercuts setup --target central --repo owner/papercuts-inbox` | One inbox repo. The label `project:owner/name` keeps the source. |

### The credential

| Credential | Command | Scope | Pictures |
| --- | --- | --- | --- |
| `gh` login (default) | `papercuts setup --target per-project` | All scopes of your `gh` login | Upload into the issue |
| Fine-grained token | `papercuts setup --target per-project --credential file --token-file <path>` | Only "Issues: read and write", only the repos you choose | GitHub refuses them. The relay keeps them and the issue links to them. |

The `gh` login works at once. Its token usually has the scopes `repo` and `workflow`, which is much more than papercuts needs. If an attacker takes over the relay, the attacker can do everything that the token allows. Use a fine-grained token if that risk is too high for you.

Run `papercuts doctor` to check the credential and the access.

## Run the relay

The relay reads its settings from the environment:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8000` | The port of the relay. |
| `PAPERCUTS_ORIGINS` | `https://*.lab.t7d.dev` | Sites that can send reports and read the list. `*` matches one host label or one port. |
| `PAPERCUTS_REPOS` | `Tim-Conrad/*` | Repos that can receive issues. |
| `PAPERCUTS_TARGET` | `per-project` | `per-project` or `central`. |
| `PAPERCUTS_CENTRAL_REPO` | none | The inbox repo for the central target. |
| `PAPERCUTS_CREDENTIAL` | `gh`, or `file` if a token file is set | `gh` or `file`. |
| `PAPERCUTS_TOKEN_FILE` | none | A file with a fine-grained token. |
| `PAPERCUTS_GH_MOUNT` | none | A read-only folder with the `gh` login (`config.yml`, `hosts.yml`). The relay gives `gh` a private copy in its temp folder before each call. |
| `PAPERCUTS_PUBLIC_URL` | none | The public URL of the relay, for the links to pictures that GitHub refused. |
| `PAPERCUTS_SHOTS_DIR` | `shots` | The folder for those pictures. |
| `PAPERCUTS_LIST_CACHE_MS` | `30000` | How long the relay keeps the list of open papercuts per repo. |

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
| `GET /shots/<id>.png` | A picture that GitHub refused. |
| `GET /status`, `GET /healthz` | Health. |

`papercuts shot` reads relay pictures from `PAPERCUTS_RELAY_INTERNAL` if you set it, for example the address of the container on the Docker network. Otherwise it uses the public link.

## Issue format

- Title: `papercut: ` and the first 70 characters of the sentence.
- Labels: `papercut`, `from:human` or `from:agent`, and `kind:<kind>`. The central target adds `project:<owner/name>`.
- Kinds: `bug`, `ux`, `copy`, `tool`, `rule`, `path`, `idea`, `other`. The widget offers `bug`, `ux`, `copy`, `idea` and `other`.
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
