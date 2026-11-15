# Agents

<!-- app-template:begin (owned by the app template; `app-sync` updates this block) -->
## Stack

Built from [app-template](https://github.com/Tim-Conrad/app-template) (custom profile).
The rules: https://github.com/Tim-Conrad/app-template/blob/main/docs/stack.md
- The app keeps its own code and build (custom profile). `nix/local.nix` says what goes into
  the image: `site` (static files, served by static-web-server on port 8000) or `service`
  (its own server on port 8000), plus `runtimePackages`, `env` and `checks`. Every lint and
  test of the app belongs in `checks`, so `nix flake check` runs it.
- A site gets, at container start: the papercuts tag in `papercutsPages` when `PAPERCUTS_URL`
  is set, `/version.json`, and the device viewer `/dev.html` in previews (`DEV_TOOLS=1`).
- **Mobile first**: check every UI change at phone and desktop size (`/dev.html` of the preview).
- The Docker image is built by Nix (`nix/default.nix`), not a Dockerfile; it runs as uid 1000
  with a read-only root. `nix/default.nix` belongs to the template: change it in app-template,
  then run `app-sync` here.

## Icon

`icon.svg in iconDir of nix/local.nix` is the app's face on the home screen, the lab dashboard and the
browser tab. Every app has its own; the template's letter is only a placeholder
(`data-placeholder`, `stack-audit` reports it). Design it from what the app does:
- One clear idea a person recognises at 48 px (a barcode for a scanner, a checklist for
  todos). Bold, simple shapes; no text, no tiny details, at most four colours.
- `viewBox="0 0 512 512"`, a full rounded-square background (`rx="96"`) in the app's colour,
  `data-bg` set to that colour, the motif inside the central 80 % (Android cuts maskable icons).
- Readable on light and dark home screens; no scripts or external references (checked).
- Then `nix run .#icons` (PNG icons for the manifest) and look at it in `/dev.html`.

## Version

Each build knows its version: the date of its commit and the short hash (`2026.11.15+8682f7b`),
set by Nix: `APP_VERSION` in the image and in `tpl.npmBuild` builds (also `VITE_APP_VERSION`),
`/version.json` of a site. Show it in the UI (footer, settings or about page), so a look at
the phone tells which build runs; name the variable `APP_VERSION` in the code (`stack-audit`
looks for it). It is also in the image label `org.opencontainers.image.version`.

## Commands
- `nix flake check`: the checks of `nix/local.nix` and the image build. Run it before every PR.
- `wt up`: preview of this worktree; `/dev.html` there shows the devices.
- `nix run .#icons` after a change to `icon.svg`.

## Dependencies

- Local gates catch problems before a commit: the dev shell freezes installs to releases at
  least 5 days old; the pre-commit hook runs dep-guard (new vulnerabilities, foreign sources,
  fresh releases) and lint; the pre-push hook runs the full dep-guard and `nix flake check`.
  Do not skip them with `--no-verify`. A fresh security fix: `DEP_GUARD_FRESH_OK=1 git commit`
  and name the advisory. An advisory without a fix: `osv-scanner.toml` with reason and date.

- Add one: `npm install <pkg>` in the npm project (`package-lock.json` in the repo root or `frontend/`); commit the lock file.
- Do not bump versions by hand for upkeep: `app-update` (dev VM timer) moves the lock files,
  security fixes at once, everything else after five days, and merges after `nix flake check`.
<!-- app-template:end -->

<!-- papercuts:begin -->
## Papercuts

Report friction with papercuts. Each papercut is a GitHub issue with the label `papercut`. If `.github/papercuts.json` sets `"store": "local"`, each papercut is a row in `.papercuts/papercuts.db` (gitignored) instead. The commands are the same.

- If a tool, a path, a rule or a page costs you time, run `papercuts add <kind> "<one sentence>" --where "<tool, file or page>"`. Kinds: bug, ux, copy, tool, rule, path, idea, other. Do not stop your task for it.
- At the start of a session, read the open papercuts that the session hook shows. If there is no hook, run `papercuts`.
- To fix one, run `papercuts view <id>`, fix it with the rules of this repo, then run `papercuts done <id> --fix "<what changed, and the commit>"`.
- If a papercut has a picture, run `papercuts shot <id>` and look at it. If it has a place, run `papercuts replay <id>` to see the page as the reporter saw it.
- If a papercut needs a decision from the owner, do not close it. Write two or three options with `papercuts comment <id> "<options>"`.
- Never put a token, a password or a key into a papercut.

### Integration

- `.github/papercuts.json` defines what a papercut of this repo contains: kinds, fields for agents, quick phrases, labels, assignees. After a change, run `papercuts config --file .github/papercuts.json --check`.
- The page loads the widget only when `PAPERCUTS_URL` is set. Keep it out of every published copy, and keep the test that checks this.
- Page hooks: `window.papercutsContext(el)` adds fields, `window.papercutsHidden()` hides the tab, `window.papercutsReplay()` records clicks for replay, `papercuts.open({ text, marks })` opens the panel with a draft.
- The full guide: https://github.com/Tim-Conrad/papercuts#integrate-papercuts-into-an-app
<!-- papercuts:end -->

## This repo

papercuts itself: the relay (`node bin/papercuts.js serve`, `src/relay.js`), the widget
(`widget/papercuts.js`, served at `/papercuts.js`) and the CLI (`bin/papercuts.js`, `src/cli.js`).
Node 22.13+ (the image has Node 24), no npm dependencies and no lock file: keep it that way.

- The relay is a `service` in `nix/local.nix`: the repo files go to `/app` in the image, with
  `gh` (the GitHub login, mounted read-only at `/gh`) and `papercuts` on the PATH.
- Every preview of every app runs the relay image built from `~/code/papercuts`
  (`WT_PAPERCUTS_IMAGE`, as `user: "0:0"`, read-only, `/data/shots` a volume), and the lab runs it
  as uid 1000. A change to the image must keep both working: check `/healthz` and `/status` of
  the built image run both ways.
- `src/agents-block.md` is the block that `papercuts init` writes into the AGENTS.md of an app
  (the papercuts block above is a copy of it). Change the block there.
- `skills/papercuts/SKILL.md` is generated from the CLI help: after a change to the help, run
  `node bin/papercuts.js skill` (`nix flake check` runs `skill --check`).
- `/healthz` and `/status` show the version (`APP_VERSION` of the image, else `package.json`).
