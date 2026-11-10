# Papercuts

Papercuts is one place where you and your agents report friction. Each papercut becomes a GitHub issue in the repo of the project.

## Why

Small problems get lost. A button overlaps on the phone. A tool prints output that an agent cannot use. A rule in `AGENTS.md` points to a file that moved. Each one costs a few minutes, again and again.

Papercuts gives people and agents the same short path to report them. All reports land in the same place, in the same format. The agent that picks up the work reads them all the same way. The result is a steady flow of small fixes.

Papercuts is for local sites: dev and review copies on your own machine or home lab. It is not a feedback widget for public visitors.

## The parts

- **Widget.** A tab on the edge of a page. You pick the part of the page that you mean, write one sentence, and send. The widget adds the context: the URL, the viewport, the element, the selected text, and the console errors.
- **JS API.** An agent that drives a browser calls `papercuts.report()` on the same page. It does not need to click the tab.
- **CLI.** An agent in a terminal runs `papercuts add tool "..."`. The output follows the [AXI](https://axi.md) rules for agent tools.
- **Relay.** A small server that holds the GitHub credential, serves the widget, and creates the issues. The browser never sees a token.

Papercuts has no runtime dependencies. It needs Node.js 22 or later.

## Quick start: a site

1. Run a relay (see [Run the relay](#run-the-relay)).
2. Add one tag to the `<head>` of the page. Put it early, so that the widget sees console errors from the start.

```html
<script src="https://papercuts.lab.example.com/papercuts.js" data-repo="owner/name"></script>
```

3. Load the page. The tab "Papercut" shows at the right edge. The keyboard shortcut is `Alt+Shift+P`.

If the relay does not answer, the page shows no tab. A public copy of the page that keeps the tag therefore shows nothing to visitors.

Optional attributes on the script tag:

| Attribute | Use |
| --- | --- |
| `data-repo` | Required. The repo for the issues, as `owner/name`. |
| `data-commit`, `data-branch` | The version of the site. The issue shows them. |
| `data-storage` | A comma list of `localStorage` keys to include. By default the widget sends no `localStorage`, because it can hold tokens or private data. |

A site can add its own fields. Define `window.papercutsContext = () => ({ openCard: "c12" })`, and the widget adds the result to each report.

## Quick start: an agent

In a terminal:

```sh
npx github:Tim-Conrad/papercuts add tool "gh-axi pr view drops the PR body" --where "gh-axi pr view"
npx github:Tim-Conrad/papercuts            # the open papercuts of this repo
npx github:Tim-Conrad/papercuts view 12
npx github:Tim-Conrad/papercuts done 12 --fix "gh-axi prints the body since commit abc1234"
```

The CLI uses the `gh` login of the host. It finds the repo from the git remote `origin`, or from `--repo owner/name`.

In a browser, on a page with the widget:

```js
if (window.papercuts) {
  await papercuts.report({ kind: "ux", text: "The save button is under the keyboard at 412 px", where: "/settings" });
}
```

`report()` never throws. It returns `{ ok, issue, url, deduped }`, or `{ ok: false, error, help, queued }`. A report that the relay cannot take now waits in the browser (IndexedDB) and goes out later.

The repo includes a skill for agents in `skills/papercuts/SKILL.md`, and a snippet for `AGENTS.md` in `AGENTS.md`.

## Setup: where papercuts go

Run `papercuts setup` once per machine. It writes `~/.config/papercuts/config.json` and installs a session-start hook for Claude Code and Codex. The hook shows the open papercuts of the current repo at the start of each agent session, and nothing when there are none.

Choose one target:

| Target | Command | Where issues go | Token scope |
| --- | --- | --- | --- |
| Per project | `papercuts setup --target per-project` | The repo of the page or of the git remote | Issues: read and write, on each allowed repo |
| Central | `papercuts setup --target central --repo owner/papercuts-inbox` | One inbox repo. The label `project:owner/name` keeps the source. | Issues: read and write, on the inbox repo only |

Use a fine-grained personal access token with only the permission "Issues: read and write". Give it access to the repos of your target and to no other repos. Run `papercuts doctor` to check the credential and the access.

## Run the relay

The relay reads its settings from the environment:

| Variable | Default | Use |
| --- | --- | --- |
| `PORT` | `8000` | The port of the relay. |
| `PAPERCUTS_ORIGINS` | `https://*.lab.t7d.dev` | Sites that can send reports. `*` matches one host label or one port. |
| `PAPERCUTS_REPOS` | `Tim-Conrad/*` | Repos that can receive issues. |
| `PAPERCUTS_TARGET` | `per-project` | `per-project` or `central`. |
| `PAPERCUTS_CENTRAL_REPO` | none | The inbox repo for the central target. |
| `PAPERCUTS_TOKEN_FILE` | none | A file with the token. Without it, the relay uses the `gh` login. |

On a laptop, for sites on `localhost`:

```sh
PAPERCUTS_ORIGINS="http://localhost:*" PAPERCUTS_REPOS="owner/*" npx github:Tim-Conrad/papercuts serve
```

Then use `http://localhost:8000/papercuts.js` in the script tag.

In a home lab, run the container behind your single sign-on proxy. `docker-compose.example.yml` shows a setup with Traefik and Authelia. Put the token in `./secrets/github-token`. The container reads it as a Docker secret.

The widget sends only simple requests: `POST` with `Content-Type: text/plain` and no custom headers. Browsers then send no CORS preflight. A login proxy can therefore stay in front of every route of the relay. The session cookie of the proxy must cover the domain of the site and of the relay. If the login expired, the widget keeps the report and asks you to log in again.

## Issue format

- Title: `papercut: ` and the first 70 characters of the sentence.
- Labels: `papercut`, `from:human` or `from:agent`, and `kind:<kind>`. The central target adds `project:<owner/name>`.
- Kinds: `bug`, `ux`, `copy`, `tool`, `rule`, `path`, `other`. The widget offers the first three and `other`.
- Body: the sentence, then a YAML block with the context, then two HTML comments: `papercut-id` (one per report) and, for agents, `papercut-fp` (the fingerprint).

Repeats:

- A report with an ID that exists already returns the first issue. A retry therefore never makes a second issue.
- A report from an agent with the same kind, place and sentence as an open papercut adds a `+1` comment to that issue. Digits, case and spaces do not change the fingerprint.
- A report from a person always opens a new issue.

## Security

- The token stays on the relay or in the `gh` login of the host. It never goes to the browser, into an issue, into a log, or into a command line.
- Papercuts replaces known secret patterns with `[redacted]` before a report leaves the machine. Examples are GitHub tokens, `Bearer` values, AWS keys, and `password=...`. The relay does it again. This catches common mistakes. It does not find every secret.
- The relay accepts reports only from the origins in `PAPERCUTS_ORIGINS`, and only for the repos in `PAPERCUTS_REPOS`. A request without an `Origin` header gets a 403.
- The widget sends no `localStorage` unless the site names the keys.
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
