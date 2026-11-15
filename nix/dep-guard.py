"""dep-guard: stop a vulnerable or unvetted dependency before it is committed.

Owned by the app template. Runs from the git pre-commit hook (`.githooks/pre-commit`, only when
a lock file is staged) and on demand: `nix run .#dep-guard [-- --all]`.

Fails when the staged lock files (compared with HEAD; `--all`: the whole lock):
  - add a known vulnerability (osv-scanner; accepted ones are listed with a reason and an
    expiry in osv-scanner.toml; advisories already in HEAD are only shown),
  - take a package from anywhere but registry.npmjs.org / pypi.org (files.pythonhosted.org),
  - bring in a package release or move a flake input to a commit younger than FREEZE_DAYS.
    Security fixes may be fresh: app-update sets DEP_GUARD_FRESH_OK=1; by hand, run with that
    variable and name the advisory in the commit. Python packages listed in
    [tool.uv.exclude-newer-package] of backend/pyproject.toml are allowed fresh.
The dev shell and the dev VM apply the same freeze at install time (npm_config_before,
[tool.uv] exclude-newer = "5 days").
"""

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

FREEZE_DAYS = 5
# package-lock.json in the root: custom apps whose npm project is the repo itself.
LOCKS = ["frontend/package-lock.json", "package-lock.json", "backend/uv.lock", "flake.lock"]
NPM = "https://registry.npmjs.org/"
PYPI = "https://pypi.org/simple"
PYFILES = "https://files.pythonhosted.org/"


def git_show(rev: str, path: str) -> str | None:
    r = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def vulns(path: str, text: str | None) -> dict[str, str]:
    """{ "package@version ID": summary } for one lock file's content."""
    if not text or path == "flake.lock":
        return {}
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / Path(path).name  # osv-scanner picks the format by file name
        f.write_text(text)
        cfg = ["--config", str(Path("osv-scanner.toml").resolve())] if Path("osv-scanner.toml").is_file() else []
        r = subprocess.run(
            ["osv-scanner", "scan", "source", *cfg, "--lockfile", str(f), "--format", "json"],
            capture_output=True,
            text=True,
        )
    if r.returncode not in (0, 1):
        raise SystemExit(f"dep-guard: osv-scanner failed (offline?):\n{r.stderr[-800:]}")
    out = {}
    for res in json.loads(r.stdout or "{}").get("results", []):
        for p in res.get("packages", []):
            pkg = f"{p['package']['name']}@{p['package'].get('version', '?')}"
            for v in p.get("vulnerabilities", []):
                out[f"{pkg} {v.get('id')}"] = (v.get("summary") or "")[:100]
    return out


def sources(path: str, text: str) -> list[str]:
    bad = []
    if path.endswith("package-lock.json"):
        for name, p in json.loads(text).get("packages", {}).items():
            if not name or p.get("inBundle"):
                continue
            res = p.get("resolved", "")
            if p.get("link") or not res.startswith(NPM) or not p.get("integrity"):
                bad.append(f"{name}: {res or 'link/no URL'}")
    elif path.endswith("uv.lock"):
        for p in tomllib.loads(text).get("package", []):
            src = p.get("source", {})
            if "registry" in src:
                ok = src["registry"].rstrip("/") == PYPI
            else:
                ok = src.get("editable") == "." or src.get("virtual") == "."
            files = ([p["sdist"]] if "sdist" in p else []) + p.get("wheels", [])
            ok = ok and all(str(f.get("url", PYFILES)).startswith(PYFILES) for f in files)
            if not ok:
                bad.append(f"{p.get('name')}: {src}")
    return bad


def ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def npm_released(name: str, version: str) -> float | None:
    url = "https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@")
    with urllib.request.urlopen(url, timeout=30) as r:
        t = json.load(r).get("time", {})
    return ts(t[version]) if version in t else None


def fresh_packages(path: str, old: str | None, new: str) -> list[str]:
    if os.environ.get("DEP_GUARD_FRESH_OK") == "1":
        return []
    limit = time.time() - FREEZE_DAYS * 86400
    bad = []
    if path.endswith("package-lock.json"):
        if old is None:
            return []  # a first lock was made under the freeze; checking 400 packages online is too slow
        before = json.loads(old).get("packages", {})
        seen = set()
        for k, p in json.loads(new).get("packages", {}).items():
            v = p.get("version")
            if not k or not v or before.get(k, {}).get("version") == v:
                continue
            name = p.get("name") or k.rsplit("node_modules/", 1)[-1]
            if (name, v) in seen:
                continue
            seen.add((name, v))
            when = npm_released(name, v)
            if when is None or when > limit:
                bad.append(f"{name}@{v} released {'?' if when is None else f'{(time.time() - when) / 86400:.1f} days ago'}")
    elif path.endswith("uv.lock"):
        exempt = set()
        pp = git_show("", "backend/pyproject.toml") or (Path("backend/pyproject.toml").read_text() if Path("backend/pyproject.toml").exists() else "")
        if pp:
            exempt = set(tomllib.loads(pp).get("tool", {}).get("uv", {}).get("exclude-newer-package", {}))
        before = {p["name"]: p.get("version") for p in tomllib.loads(old or "").get("package", [])}
        for p in tomllib.loads(new).get("package", []):
            if before.get(p["name"]) == p.get("version") or "registry" not in p.get("source", {}) or p["name"] in exempt:
                continue
            times = [ts(f["upload-time"]) for f in ([p["sdist"]] if "sdist" in p else []) + p.get("wheels", []) if "upload-time" in f]
            if times and min(times) > limit:
                bad.append(f"{p['name']}=={p.get('version')} uploaded {(time.time() - min(times)) / 86400:.1f} days ago")
    return bad


def fresh_inputs(old: str | None, new: str) -> list[str]:
    # A first lock (a new app) has nothing to compare with; app-update moves it later.
    if os.environ.get("DEP_GUARD_FRESH_OK") == "1" or old is None:
        return []
    before = {k: v.get("locked", {}).get("rev") for k, v in json.loads(old or "{}").get("nodes", {}).items()}
    limit = time.time() - FREEZE_DAYS * 86400
    bad = []
    for k, v in json.loads(new).get("nodes", {}).items():
        lk = v.get("locked")
        if lk and lk.get("rev") != before.get(k) and lk.get("lastModified", 0) > limit:
            age = (time.time() - lk["lastModified"]) / 86400
            bad.append(f"{k} -> {lk.get('rev', '?')[:10]} is {age:.1f} days old (< {FREEZE_DAYS})")
    return bad


def main() -> int:
    all_ = "--all" in sys.argv
    staged = subprocess.run(["git", "diff", "--cached", "--name-only"], capture_output=True, text=True).stdout.split()
    paths = [p for p in LOCKS if (all_ and Path(p).exists()) or p in staged]
    problems, notes = [], []
    for p in paths:
        new = Path(p).read_text() if all_ else git_show("", p)
        if new is None:
            continue
        old = None if all_ else git_show("HEAD", p)
        problems += [f"{p}: source not allowed: {b}" for b in sources(p, new)]
        if p == "flake.lock":
            problems += [f"flake.lock: {b}" for b in fresh_inputs(old, new)]
            continue
        problems += [f"{p}: younger than {FREEZE_DAYS} days: {b}" for b in fresh_packages(p, old, new)]
        now_v, old_v = vulns(p, new), vulns(p, old)
        problems += [f"{p}: new vulnerability {k} {s}" for k, s in sorted(now_v.items()) if k not in old_v]
        notes += [f"{p}: known {k} {s}" for k, s in sorted(now_v.items()) if k in old_v]
    for n in notes:
        print(f"dep-guard: note: {n}")
    if problems:
        print("dep-guard: refused:", *problems, sep="\n  ", file=sys.stderr)
        print("Fix: pick a fixed version (`npm audit fix`, `uv lock --upgrade-package <pkg>`), or wait"
              f" for the {FREEZE_DAYS}-day freeze. A fresh security fix: DEP_GUARD_FRESH_OK=1 git commit ..."
              " (name the advisory). An advisory without a fix: accept it in osv-scanner.toml with a reason"
              " and ignoreUntil.", file=sys.stderr)
        return 1
    if paths:
        print(f"dep-guard: ok ({', '.join(paths)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
