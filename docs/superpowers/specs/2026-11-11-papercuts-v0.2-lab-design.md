# Papercuts v0.2 and the lab rollout: design

Status: draft for Tim. Builds on `2026-11-10-papercuts-design.md` (v0.1).

## Intent

Papercuts becomes the one feedback path for every lab app. Tim reports from the page, agents report from the terminal or the browser, and both land as issues in the repo of the app. The lab rollout is the dogfood step: each friction that shows up during the rollout becomes a papercut against papercuts and gets fixed before the next app.

pen-and-paper has its own note tool (anmerkung) with features that Tim uses. v0.2 ports those features into papercuts, so that pen-and-paper can drop anmerkung and `papercut.py`, and every app gets the same features.

## Goals

- Every lab app with a page shows the papercuts tab, on the live and the dev copy.
- No published copy loads papercuts. A feature flag per app controls this. The public copies are t7d.dev and `tiny-train.beacon.host`.
- The widget can do what anmerkung does today (see "Widget v0.2").
- Setup offers two credentials: the `gh` login or a fine-grained PAT. The lab uses the `gh` login.
- Agents in each lab repo find papercuts without help: a SessionStart hook, an `AGENTS.md` block, and a `papercuts` command on the PATH.
- The deferred minors from the v0.1 review are fixed.

## Non-goals

- The credential broker. It stays a draft on the site.
- Feedback from public visitors.
- npm publish. The repo stays private for now, but every file is written as if it were public.

## Anti-goals

- A token or private key in the browser, in an issue, in a log, or in a command line.
- A published copy that leaks the relay URL or makes a request to it.
- Losing an anmerkung feature that Tim uses, without telling him first.
- Decrypted content of a sealed site in an issue.

## Decisions by Tim (2026-11-11)

- Target: per project. Each app gets the issues in its own repo.
- Credential: setup offers both the `gh` login and a PAT. The lab uses the `gh` login, because it works at once ("GitHub App" meant the gh CLI).
- pen-and-paper: port anmerkung into papercuts, then remove anmerkung and `papercut.py`.
- Where: live and dev copies. A published copy turns papercuts off with a feature flag.

## The how: decided

### 1. Credential sources

The relay and the CLI take one of two sources. `setup` asks which one.

| Source | Config | Notes |
| --- | --- | --- |
| `gh` | `GH_CONFIG_DIR` (optional) | The `gh` login. Default for the CLI and the lab relay. Works at once, and can upload pictures. |
| `file` | `PAPERCUTS_TOKEN_FILE` | A fine-grained PAT with Issues: read and write. Narrower, but it cannot upload pictures. |

The lab relay uses the `gh` login of `developer`:

- The image installs `gh` (Alpine package `github-cli`).
- Compose mounts `~/.config/gh` read-only and sets `GH_CONFIG_DIR` to it. The relay runs `gh auth token` at call time, as the CLI does today. No new copy of the token lands on disk. After `gh auth refresh` on the host, the relay uses the new token.
- A 401 from GitHub clears the cached token, and the next call asks `gh` again. This fixes the deferred minor "the relay needs a restart after a token change".

**Security: the scope of the `gh` token.** It has the classic scopes `repo`, `workflow` and `delete_repo`. If an attacker takes over the relay, the attacker can do everything that the token allows, not only file issues. These limits apply:

- The relay sits behind Authelia, accepts only the origins and repos in its allow lists, and calls only issue and upload endpoints.
- It runs as a non-root user with a read-only root file system, no shell access from outside, and `mem_limit`.
- The `file` source with a fine-grained PAT stays the narrow choice. The broker draft is the long-term fix.

### 2. Pictures

The `gh` login can upload a picture to an issue. `gh issue create --attach` does it through `POST https://uploads.github.com/user-attachments/assets?content_type=&name=&repository_id=` (verified on 2026-11-11 with `GH_DEBUG=api`). The endpoint is not documented. Installation tokens get a 404 there ([cli/cli#14309](https://github.com/cli/cli/issues/14309)).

- `POST /report` takes an optional PNG (data URL, max 8 MB, checked magic bytes).
- The relay uploads it with the token, and the issue shows it inline as `![papercut](<asset url>)`.
- If the upload fails, or the source is `file`, the relay keeps the PNG in a volume as `shots/<report id>.png`, and the issue links to `https://<relay>/shots/<id>.png`. The report still goes out.
- Agents read a picture with `papercuts shot <issue> [--out file]`. The CLI downloads the asset with the token, or reads it from the relay.

Note: the pictures of private pages, for example the pen-and-paper reference photos, then sit on GitHub as attachments of a private repo. anmerkung already does this today.

### 3. Widget v0.2

New in the widget, ported from anmerkung:

- **Marks on a picture.** "Mark picture" on a selected `<img>`, and "Mark screen" on desktop (`getDisplayMedia`). A drawing sheet has a pen, numbered pins with one line of text each, undo, and clear. The result is the PNG of section 2, and the pin texts go into the issue as a list.
- **Open papercuts in the panel.** A list of the open papercuts of this repo, with the reply count, a badge for new replies (seen state in `localStorage`), and "Go to place". That button restores the hash and the scroll position of the report. The relay serves the list at `GET /list?repo=` for allowed origins only.
- **Voice input.** A microphone button that uses the Web Speech API, where the browser has it. The language comes from `data-lang`.
- **Languages.** `data-lang="en"` (default) or `"de"`. All strings of the widget are in one table.
- **Placement.** The tab can be dragged, and the position is saved. When a modal `<dialog>` is open, the widget moves into it, so that it stays on top.
- **Hide hook.** `window.papercutsHidden = () => bool`, checked on each open. pen-and-paper uses it for the kids mode and the print view.
- **Keyboard.** `Ctrl+Enter` sends.
- **No relay.** With `?papercuts=download`, the widget offers the report as a JSON file. `papercuts import <file>` files it later. This replaces `python3 anmerkung.py einlesen`.
- **Kinds.** The widget offers `bug`, `ux`, `copy`, `idea`, `other`. `idea` is new in `KINDS`.

Fix from the review: the browser queue stores the report after redaction.

### 4. Replay

`papercuts replay <issue> [--out file.png]` shows what the reporter saw:

- It opens the URL with the same viewport, hash, scroll position and named `localStorage` keys.
- It draws a red frame around the reported element and writes a PNG.
- It runs Playwright through `uv`, the same way as the browser check today. It adds no npm dependency. Without `uv`, it prints the replay data as TOON, so that an agent can drive its own browser.

This replaces `anmerkung_zeigen.py`.

### 5. Feature flag per app

The script tag goes into a page only when the app runs in the lab. The rule for every app is: if `PAPERCUTS_URL` is set, add the tag. Otherwise, add nothing.

| App | Where the flag goes |
| --- | --- |
| Static nginx apps (pen-and-paper, kleinbahn) | The lab compose sets `PAPERCUTS_URL`. An nginx `sub_filter`, or the build step, adds the tag. The public build of kleinbahn (beacon.host) does not set it. |
| FastAPI apps (fitness, organizer, scanner, klima, apk-market, humidity-checker) | The app reads `PAPERCUTS_URL` when it serves `index.html` and adds the tag. |
| scrcpy-lite, sealed admin | The same pattern as their server. |
| Vite apps | The tag is added at serve time, not at build time, so that one image works in the lab and outside it. |

The builder chooses the exact mechanism per app. The contract does not change: no env var, no tag.

`data-repo` comes from the same place. The pages also send `data-commit` where the app knows its commit.

The site t7d.dev keeps no tag. Its review copy can add one later, but that is not part of this rollout.

### 6. Lab relay

- `~/lab/apps/papercuts/` holds a compose file from `docker-compose.example.yml`: `papercuts.lab.t7d.dev`, `authelia@file`, `security-headers@file`, a Homepage entry, `mem_limit: 128m`, and a volume for `shots/` (the fallback of section 2).
- Credential: `~/.config/gh` mounted read-only (section 1). No secret file in the app folder.
- `PAPERCUTS_ORIGINS=https://*.lab.t7d.dev`, `PAPERCUTS_REPOS=Tim-Conrad/*`.
- `GET /shots/*` and `GET /list` are read paths. Browser requests come through Traefik and Authelia. The relay itself has no login, so a direct request on the `proxy` network gets an answer.
- Verified on 2026-11-11: the host reaches a container on the `proxy` network by its IP, with the source address `172.30.0.1`. `papercuts shot` uses this path. The relay needs a stable address for it: a fixed `ipv4_address`, or a lookup with `docker inspect`. The builder chooses.
- Security note: any program of the `developer` user can call the relay directly and read the pictures. This is no new exposure. That user is in the `docker` group, which is equal to root, and can already read every volume.
- `lab-ctl`, `apps/CLAUDE.md` and `bootstrap.sh` know the new app.

### 7. Agents in the lab

- `npm install -g github:Tim-Conrad/papercuts#v0.2.0` on this host, so that `papercuts` is on the PATH. `npx` stays the documented path for other people.
- `papercuts setup --target per-project --hooks claude,codex`. The hook calls `papercuts` from the PATH, and falls back to the stored path. This fixes the deferred minor about a Node upgrade.
- `setup` writes the settings files atomically: a temp file, then a rename.
- Each app repo gets the `AGENTS.md` block from `AGENTS.md` of papercuts.
- In pen-and-paper, `papercut.py`, its skill, its tests and its `AGENTS.md`/`CLAUDE.md` lines go away.

### 8. Rollout order

1. papercuts v0.2 (sections 1 to 4, 7) with tests. Release `v0.2.0`.
2. The lab relay (section 6) with the `gh` login.
3. pen-and-paper: the widget replaces anmerkung, and `papercuts` replaces `papercut.py`. Tim checks it on the review site before the old code goes.
4. The other apps, one PR each: fitness, organizer, scanner, klima, apk-market, humidity-checker, scrcpy-lite, kleinbahn, sealed admin.
5. After each app, the papercuts that came up during the work are fixed in papercuts before the next app.

Each app: a branch in a separate clone, a PR with Before and After screenshots, then merge and `./lab-ctl deploy <app>`.

### 9. Sealed sites

- The sealed admin page gets the widget.
- The sealed player and GM copies (`pen-and-paper-sealed.lab.t7d.dev`) get no widget. Their pages hold decrypted text, and a report would copy it into an issue. This is my call. Tim can reverse it.

## Answers to the builder check (my calls, Tim can reverse each)

- **Read paths and the login.** The relay needs no network rule. A browser request reaches the relay only through Traefik, after Authelia. A direct request on the `proxy` network skips Traefik. Browser reads (`GET /list`) keep the origin check. A read without an `Origin` header (the CLI) gets an answer. A write without an `Origin` header still gets a 403.
- **Old anmerkung issues.** pen-and-paper has 0 open anmerkung issues. The closed ones get the labels `papercut` and `from:human`, so that the history shows in one place. They keep their old body format. Replies in v0.2 are issue comments.
- **pen-and-paper files.** These go away: `anmerkung.py`, `anmerkung_zeigen.py`, `karten/webseite/anmerkung.js`, `anmerkung.css`, `papercut.py`, their tests and skills, and `/api/anmerkung` in `devserver.py`. The builder removes other code that only anmerkung uses.
- **Feature inventory.** Before pen-and-paper drops anmerkung, the builder lists every anmerkung feature against the widget. Tim sees each feature that does not move, before the old code goes. The URL switches `anmerken=0`, `pruefen=1` and `nurdruck=1` map to `papercutsHidden` in pen-and-paper.
- **Sealed admin.** Its issues go to `Tim-Conrad/sealed`.
- **Dev copies.** `*.lab.t7d.dev` matches `<app>-dev.lab.t7d.dev`. Dev copies use the same relay and file into the real repo. The widget shows the host in the context, so that each issue shows the copy it came from.
- **Replay hosts.** Replay opens the URL of the report. If that host needs a login, `--base <url>` points it at a dev copy or a local server of the same page.
- **Steps that need Tim.** None for the credential. Tim approved the release and the rollout on 2026-11-11. Lab PRs merge and deploy as the lab memory says. If the harness blocks a merge, the PR waits for Tim.

## Left to the builder

- The exact tag mechanism per app (section 5).
- The look of the drawing sheet and the list, within the current widget style.
- Test cases beyond the ones named in the plan.

## Open risks

- The upload endpoint is not documented. If GitHub changes it, pictures fall back to the relay volume.
- The proxy-network read path (section 6) must be verified on this host before `papercuts shot` depends on it.
