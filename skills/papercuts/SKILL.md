---
name: papercuts
description: Use when a tool, a path, a rule or a page gives you friction, or when the session start lists open papercuts. Report each papercut with one command, and fix and close open ones.
---

# Papercuts

Papercuts is the one place where Tim and his agents report friction. Each papercut is a GitHub issue with the label `papercut`.

## When to report

Report a papercut when something costs you time and a small change can fix it:

- A tool fails, or prints output that you cannot use (`tool`).
- A rule in AGENTS.md or CLAUDE.md is unclear or contradicts another rule (`rule`).
- A path in a doc or a script is wrong (`path`).
- A page has a bug, a layout problem or wrong text (`bug`, `ux`, `copy`).

Do not stop your task to report. Report in one command and continue. A repeat adds +1 to the open papercut, so do not search first.

## Commands

- `papercuts add <kind> "<text>" [--where <place>] [--repo <owner/name>]`: Report one papercut as an agent. A repeat of an open papercut adds +1 to it.
- `papercuts list [--from agent|human] [--kind <kind>] [--fields <a,b>] [--repo <owner/name>]`: List the open papercuts of the repo.
- `papercuts view <id> [--full] [--repo <owner/name>]`: Show one papercut with its context.
- `papercuts done <id> --fix "<what changed>" [--repo <owner/name>]`: Close a papercut with a note about the fix. A closed papercut is a no-op.
- `papercuts setup --target per-project|central [--repo <owner/name>] [--hooks claude,codex|none]`: Choose where papercuts go, and show them at the start of each agent session.
- `papercuts doctor [--repo <owner/name>]`: Check the credential and the access to the target repo.

Run `papercuts` with no arguments to see the open papercuts of the current repo.

## Fix and close

1. Run `papercuts view <id>` to read the papercut and its context.
2. Fix it with the normal rules of the repo: a branch, a test first for a bug, the checks.
3. Run `papercuts done <id> --fix "<what changed, and the commit>"`.

If a papercut needs a decision from Tim, do not close it. Write two or three options as a comment on the issue.

## Rules

- Write one sentence. Name the tool, the file or the page.
- Never put a token, a password or a key into a papercut. Papercuts redacts known secret patterns, but not all of them.
