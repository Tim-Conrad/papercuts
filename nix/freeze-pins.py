"""freeze-pins: move flake inputs that are younger than five days back to the newest commit of
their branch that is at least five days old (`nix run .#freeze-pins`). Owned by the app template.

A new app runs it once (copier task), so its first lock follows the same freeze as everything
else. Later moves are app-update's job. Uses the public GitHub API (no token needed).
"""

import json
import subprocess
import time
import urllib.request
from datetime import UTC, datetime, timedelta

FREEZE_DAYS = 5


def api(path: str):
    req = urllib.request.Request("https://api.github.com/" + path, headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> None:
    lock = json.load(open("flake.lock"))
    limit = time.time() - FREEZE_DAYS * 86400
    cutoff = (datetime.now(UTC) - timedelta(days=FREEZE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    changed = False
    for name, node in lock["nodes"].items():
        lk, orig = node.get("locked"), node.get("original", {})
        if not lk or lk.get("type") != "github" or lk.get("lastModified", 0) <= limit:
            continue
        ref = orig.get("ref") or api(f"repos/{lk['owner']}/{lk['repo']}")["default_branch"]
        commits = api(f"repos/{lk['owner']}/{lk['repo']}/commits?sha={ref}&until={cutoff}&per_page=1")
        if not commits:
            continue
        rev = commits[0]["sha"]
        pre = json.loads(subprocess.run(
            ["nix", "flake", "prefetch", "--json", f"github:{lk['owner']}/{lk['repo']}/{rev}"],
            check=True, capture_output=True, text=True).stdout)
        lk.update(rev=rev, narHash=pre["hash"], lastModified=pre["locked"]["lastModified"])
        print(f"freeze-pins: {name} -> {rev[:10]} ({ref}, older than {FREEZE_DAYS} days)")
        changed = True
    if changed:
        with open("flake.lock", "w") as f:
            json.dump(lock, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
