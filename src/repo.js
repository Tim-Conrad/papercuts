// The GitHub repo of a folder, from its git remote "origin".
import { execFileSync } from 'node:child_process';

export function parseRemote(url) {
  const m = String(url).trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function repoFromGit(cwd) {
  try {
    // The configured URL, not `git remote get-url`: that applies url.<base>.insteadOf, and a rewrite
    // to a gateway (https://gh.gate/...) would hide that the repo is on GitHub.
    return parseRemote(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
  } catch {
    return null;
  }
}
