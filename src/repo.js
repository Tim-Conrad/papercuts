// The GitHub repo of a folder, from its git remote "origin".
import { execFileSync } from 'node:child_process';

export function parseRemote(url) {
  const m = String(url).trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function repoFromGit(cwd) {
  try {
    return parseRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
  } catch {
    return null;
  }
}
