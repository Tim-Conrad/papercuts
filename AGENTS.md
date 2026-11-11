# Papercuts snippet for AGENTS.md

Copy the block below into the `AGENTS.md` or `CLAUDE.md` of a project. It tells agents when and how to report friction.

```markdown
## Papercuts

Report friction with papercuts. Each papercut is a GitHub issue with the label `papercut`.

- If a tool, a path, a rule or a page costs you time, run `papercuts add <kind> "<one sentence>" --where "<tool, file or page>"`. Kinds: bug, ux, copy, tool, rule, path, idea, other. Do not stop your task for it.
- At the start of a session, read the open papercuts that the session hook shows. If there is no hook, run `papercuts`.
- To fix one, run `papercuts view <id>`, fix it with the rules of this repo, then run `papercuts done <id> --fix "<what changed, and the commit>"`.
- If a papercut has a picture, run `papercuts shot <id>` and look at it. If it has a place, run `papercuts replay <id>` to see the page as the reporter saw it.
- If a papercut needs a decision from the owner, do not close it. Write two or three options as a comment on the issue.
- Never put a token, a password or a key into a papercut.
```
