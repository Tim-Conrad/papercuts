# Papercuts: design

Date: 2026-11-10. Owner: Tim Conrad. Status: draft for review.

## Intent

Papercuts is the one place where Tim and his agents report friction. Each report becomes a GitHub issue in the repo of the project. The goal is regular, small improvements, and no feedback that gets lost.

Today the same idea exists three times, in three shapes:

- pen-and-paper `karten/webseite/anmerkung.js` + `anmerkung.py` + `devserver.py`: a tab on the review site. Tim picks an element, writes a note, and draws on pictures. The page collects context, and the dev server files a GitHub issue (label `anmerkung`) with `gh`. It has an offline queue in IndexedDB and an idempotency key (`kennung`).
- pen-and-paper `papercut.py`: a one-line CLI log for agents. It removes duplicates (same kind, place, sentence), redacts secrets, groups repeats, and files one issue per group of two or more.
- t7d.dev `tools/review/review.js` + `devserver.py`: a »Note« tab that writes JSON files to `.review/notes/`, not issues.

Papercuts generalizes these into one public, MIT-licensed project: `Tim-Conrad/papercuts`.

## Goals

1. A browser widget that a local site adds with one `<script>` tag. Tim picks an element (or the whole view), writes a sentence, and sends. The widget adds the context automatically.
2. A JS API on the same script (`window.papercuts.report({...})`), so that an agent that drives a browser files a papercut without a click on the tab.
3. A CLI for agents in a terminal: `papercuts add <kind> "<sentence>" [--where ...]`.
4. One issue format for all three sources. An agent that picks up papercuts reads them all the same way.
5. A »Tools« sheet on t7d.dev. Papercuts is its first entry. The tool page shows the papercuts README, rendered at deploy time, so that the site and the repo do not drift.

## Non-goals

- Public sites. The widget is for local dev and review copies only. It never loads for visitors.
- The lab rollout. Replacing the three existing copies and adding papercuts to every lab app is a later dogfood step. This build must make that step a one-line change per app, but it does not do it.
- Drawing on pictures (the pen-and-paper sheet with circle, arrow, pins). It is specific to the card pictures. A later version can add it.
- A web UI to browse papercuts. GitHub issues are the UI.
- Replay scripts (`anmerkung_zeigen.py`, `show.py`). See "Left to the builder".

## Anti-goals

- A widget that is visible on a public page, or that leaks `localStorage`, tokens, or secrets into an issue.
- A GitHub token in the browser.
- A setup that needs a build step, an npm install, or a framework in the host site.
- An issue list full of noise from agents.

## Constraints

- Tim's lab: Docker on one 4 GB LXC. Apps at `https://<app>.lab.t7d.dev` behind Authelia SSO, routed by Traefik labels on the `proxy` network, no host ports. See `~/lab/CLAUDE.md` and the `serve-app` skill.
- Ask Tim before adding a dependency. Target: zero runtime dependencies.
- Writing style for README, docs, comments, and errors: ASD-STE100 (Tim's global CLAUDE.md).
- Secrets: never logged, never in an issue. Redact with the patterns of `papercut.py` (`GEHEIM`).
- t7d.dev rules (its `CLAUDE.md` and `DESIGN.md`): plain HTML, no build step, no dependencies, strict CSP (no inline scripts or styles), black and white, plain wording. A new top-level folder goes into `SITE` in `scripts/deploy.sh` (after the rename) and into `sitemap.xml`.

## The how: decided

### Parts

One repo, three parts, one shared format module:

1. **Relay** (`papercuts serve`): a small HTTP server. It holds the GitHub token and creates issues. It serves the widget at `/papercuts.js`. It runs as one lab container at `papercuts.lab.t7d.dev` behind Authelia, and also runs on a laptop with `npx papercuts serve`.
2. **Widget** (`papercuts.js`): plain browser JS, no framework, no build. It uses a Shadow DOM, so that the host page CSS does not change it and it does not change the host page.
3. **CLI** (`papercuts add|list|done`): for agents in a terminal.

### Language (Claude's call)

Node.js, standard library only (`node:http`, `node:test`, `fetch`). Reason: the widget is JS, so one language covers the whole repo, and `npx papercuts` works on any machine with Node. Node 22 is on the lab host.

### Integration

```html
<script src="https://papercuts.lab.t7d.dev/papercuts.js" data-repo="Tim-Conrad/pen-and-paper" defer></script>
```

- The relay only accepts repos on an allowlist (env var `PAPERCUTS_REPOS`, for example `Tim-Conrad/*`).
- The relay sends CORS headers only for allowed origins (env var `PAPERCUTS_ORIGINS`, default `https://*.lab.t7d.dev`). It rejects a POST whose `Origin` is not on the list (this is also the CSRF guard).
- The widget shows the tab only if the relay answers. If the relay does not answer, the widget shows nothing. A public page that copies the tag therefore shows nothing to visitors.

### Auth through Authelia (Claude's call, from the builder check)

- The Authelia session cookie has the domain `lab.t7d.dev` (`infra/platform/authelia/configuration.yml`). A page at `x.lab.t7d.dev` and the relay at `papercuts.lab.t7d.dev` are the same site, so the browser sends the cookie with the script load and with `fetch(..., {credentials: 'include'})`.
- A CORS preflight (`OPTIONS`) carries no cookie, and Authelia redirects it. So the widget sends only "simple" requests: `POST` with `Content-Type: text/plain` (the body is JSON text), and no custom headers. Then no preflight happens, and Authelia stays on the whole relay route with no bypass.
- If the session expired, Authelia answers with a redirect. The widget treats this like "offline": it queues the report and shows "log in again at lab.t7d.dev".
- A site on `http://localhost:*` is cross-site, so the cookie does not go there. For localhost, run a local relay: `npx github:Tim-Conrad/papercuts serve`, which uses the host's `gh` login, and point the script tag at it.

### Target repo (Tim asked for this)

Setup chooses where issues go. It uses flags only, no prompts (AXI):

- `papercuts setup --target central --repo Tim-Conrad/papercuts-inbox`: all papercuts go to one repo. The issue gets a `project:<repo>` label, so that the source stays visible. The token needs access to that one repo only.
- `papercuts setup --target per-project`: each papercut goes to the repo that the script tag or the git remote names. The token needs access to each allowed repo.

The relay reads the same setting (`PAPERCUTS_TARGET`, `PAPERCUTS_CENTRAL_REPO`). Setup prints the exact token scope for the chosen target, and `papercuts doctor` reports whether the current credential has that scope.

### Credential source (seam for a later secret broker)

The relay and the CLI get the GitHub credential through one small interface with three sources: `gh` login, a token file, and a broker socket. This build implements the first two. The third is the seam for the separate broker project.

### Token (Claude's call)

- Lab relay: a fine-grained PAT with "Issues: read and write" on the allowed repos. Tim creates it. It lives in `~/lab/apps/papercuts/secrets/github-token` (gitignored), and the container reads it as a Docker secret file. It never goes into the env or a log.
- Local relay and CLI: the host's `gh` login (as `pen-and-paper/anmerkung.py` does).
- Only Authelia users reach the relay. Today that is Tim. No per-user check in this build.
- Labels (`papercut`, `from:*`, `kind:*`) are created on first use. "Issues: write" covers labels.

### Context that the widget adds

From the pen-and-paper list, without the app-specific parts:

- URL with hash, page title, viewport, device pixel ratio, user agent, theme (`prefers-color-scheme`).
- The picked element: CSS path, text (shortened), `data-*` of it and its parents, bounding box, and the scroll position.
- The selected text, if any.
- Console errors and unhandled rejections since the page load. The script must load early (in `<head>`) to see them.
- Optional: `data-commit` and `data-branch` on the script tag, or a `window.papercutsContext()` hook that the site defines for its own fields (for example the open card in pen-and-paper).
- Not `localStorage` by default. A site can opt in with `data-storage="key1,key2"`. Reason: `localStorage` can hold spoilers or tokens.

### Offline queue

Like pen-and-paper: if the relay does not answer, the report waits in IndexedDB and goes out later. Each report has a client id. A second send with the same id returns the first issue (the id goes into the issue body as an HTML comment).

### Issue format

- Title: `papercut: <first 70 chars of the sentence>`.
- Labels: `papercut`, plus `from:human` or `from:agent`, plus `kind:<kind>`.
- Kinds: `bug`, `ux`, `copy`, `tool`, `rule`, `path`, `other`. The widget offers `bug`, `ux`, `copy`, `other`. The CLI accepts all.
- Body: the sentence first, then a YAML frontmatter-like block with the context, then the client id as `<!-- papercut-id: … -->` and a fingerprint as `<!-- papercut-fp: … -->`.
- The format module validates and redacts before anything leaves the machine. The relay redacts again.

### Agent noise

Tim decided (Q1): issue at once, `+1` on repeats. The format module computes a fingerprint (kind + place + normalized sentence) for every report with `from:agent`, from the CLI and from the JS API alike. Before it opens an issue, it lists the open issues with the label `papercut` (REST list, not search: search does not match HTML comments reliably) and looks for `<!-- papercut-fp: … -->`. On a match it adds a `+1` comment with the new context and returns `{issue: N, deduped: true}`. The widget then shows "added to #N". Reports from humans are never merged. GitHub is the only store, with no local log file. That is the "one place".

### Agent experience: AXI (Tim asked for this)

The CLI follows the 10 AXI principles (https://axi.md, spec in `kunchenguid/axi` `SKILL.md`), like the `*-axi` tools on the lab host:

1. Output on stdout in TOON. A small TOON encoder in the repo (no dependency). Internal data stays JSON.
2. Lists show 3-4 fields: `papercuts[N]{id,kind,title,count}`. `--fields` adds more.
3. Long bodies are cut to about 800 characters with "(truncated, N chars total)" and a `papercuts view <id> --full` hint, only when cut.
4. Lists carry aggregates: `count: 12 of 31 open`, `from: 9 agent, 3 human`.
5. Empty states say what is empty: `papercuts: 0 open in Tim-Conrad/pen-and-paper`.
6. Errors go to stdout in the same format with a `help:` line. Exit 0 for success and no-ops (`done` on a closed issue: "#42 already closed (no-op)"), 1 for errors, 2 for usage errors and unknown flags. No prompts. Required flags are checked before any `gh` call. `gh` errors are translated, not passed through.
7. Ambient context: `papercuts setup` installs a SessionStart hook (Claude Code, Codex) that shows the open papercuts of the current repo. It is idempotent. This replaces the "at session start, run `gh issue list`" lines in each AGENTS.md. The skill `skills/papercuts/SKILL.md` comes from the home view, and `papercuts skill --check` fails in CI if it drifts.
8. Content first: `papercuts` with no arguments prints `bin:`, `description:`, the open papercuts of the current repo, and `help[]` hints.
9. Next steps as full commands, with `--repo` carried forward: `help[2]: Run \`papercuts view <id>\` …`.
10. `--help` on every subcommand with flags, defaults and 2-3 examples. `-v`/`--version` print the bare version.

The JS API follows the same spirit: `papercuts.report()` returns `{ok, issue, url, deduped}` or `{ok: false, error, help}`, never throws for a rejected report, and `papercuts.status()` returns whether the relay answers. The relay answers JSON with the same `error`/`help` fields.

### CLI transport

The CLI uses `gh` on the host directly (as `papercut.py` does), not the relay. Reason: the relay is behind Authelia, and a terminal has no SSO cookie. The CLI shares the format module with the relay, so the issues are identical. The repo comes from `--repo` or from the git remote of the current folder.

### Agent instructions

The repo ships `AGENTS.md` snippet text and a skill (`skills/papercuts/SKILL.md`) that tells an agent when to file a papercut, how, and how to pick up and close open papercuts. Tim copies the snippet into a project.

### Website: the Tools sheet

- A new sheet »Tools« on the t7d.dev front page, after Research. The sheet numbers after it move by one.
- A tool page per tool at `/tools/<tool>/`. Tim decided (Q2): move the current script folder `tools/` to `scripts/` and update every reference (workflow, `CLAUDE.md`, `README.md`, `ship.sh`, `deploy.sh`). Add `tools` to `SITE` in `deploy.sh`.
- `tools/<tool>/index.html` holds the site `<head>`, a short intro in Tim's voice (what it is, why it exists, which problem it solved), and a placeholder. At deploy, a new script `scripts/gen-tools.py` fetches the README of the tool from GitHub at its latest release tag and renders it into the placeholder. `scripts/deploy.sh` runs it in the GitHub workflow, as it runs `gen-feeds.py` now, from `scripts/` (Claude's call).
- If the fetch fails, the deploy fails loud. A silent old page is drift. A failed deploy is visible and a re-run fixes it (Claude's call).
- The papercuts repo has a release tag `v0.1.0` at the end of this build, so that the site has a tag to fetch.
- A list `tools/tools.json` names the tools (slug, repo, one-line description). The front-page sheet and the `/tools/` index come from that list at deploy, so that the next tool is one entry.
- Markdown rendering: Tim decided (Q3): `pip install markdown` (Python-Markdown, pinned version) only in the deploy workflow. The site stays dependency-free.

## Left to the builder

- Module layout, test layout, the exact widget look (match the pen-and-paper tab: a small tab on the right edge).
- Keyboard shortcut to open the widget.
- Whether to port a replay script (`show.py`) now. Recommended: later, with the dogfood step.
- The Dockerfile and compose for the lab relay, by the canonical lab compose.
- Publishing to npm: not in this build. `npx github:Tim-Conrad/papercuts` works without it.

## Decisions by Tim

- Q1. Agent repeats: issue at once, `+1` comment on repeats.
- Q2. URL: `/tools/<tool>/`, script folder moves to `scripts/`.
- Q3. Markdown: Python-Markdown, installed only in CI.
- Scope: local sites only. The lab rollout is a later dogfood step.
- AXI principles for the agent experience.
