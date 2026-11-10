// Settings for the relay and the CLI. The env wins over the file that `papercuts setup` writes.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.1.0';

export function configPath(env = process.env) {
  return join(env.PAPERCUTS_CONFIG_DIR || join(env.HOME || homedir(), '.config', 'papercuts'), 'config.json');
}

export function readConfigFile(env = process.env) {
  try {
    return JSON.parse(readFileSync(configPath(env), 'utf8'));
  } catch {
    return {};
  }
}

const list = (text) => String(text).split(',').map((s) => s.trim()).filter(Boolean);

function globToRegex(glob) {
  // `*` matches one host label or one port: never a dot, a slash or a colon.
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^./:]+');
  return new RegExp(`^${body}$`);
}

export function originAllowed(origin, origins) {
  return Boolean(origin) && origins.some((g) => globToRegex(g).test(origin));
}

export function repoAllowed(repo, repos) {
  // Repo names may contain dots, so a repo glob matches one path part instead.
  return repos.some((g) => {
    const [owner, name] = g.split('/');
    const [ro, rn] = repo.split('/');
    return (owner === '*' || owner.toLowerCase() === ro?.toLowerCase()) && (name === '*' || name?.toLowerCase() === rn?.toLowerCase());
  });
}

export function loadConfig(env = process.env, file = {}) {
  const mode = env.PAPERCUTS_TARGET || file.target || 'per-project';
  if (!['per-project', 'central'].includes(mode)) throw new Error(`PAPERCUTS_TARGET must be per-project or central, not "${mode}"`);
  const target = { mode };
  if (mode === 'central') {
    target.centralRepo = env.PAPERCUTS_CENTRAL_REPO || file.centralRepo;
    if (!target.centralRepo) throw new Error('central target needs PAPERCUTS_CENTRAL_REPO (owner/name)');
  }
  const tokenFile = env.PAPERCUTS_TOKEN_FILE || file.tokenFile;
  return {
    origins: list(env.PAPERCUTS_ORIGINS || 'https://*.lab.t7d.dev'),
    repos: list(env.PAPERCUTS_REPOS || 'Tim-Conrad/*'),
    target,
    credential: tokenFile ? { source: 'file', path: tokenFile } : { source: 'gh' },
    port: Number(env.PORT || 8000),
    testRedirect: env.PAPERCUTS_TEST_REDIRECT === '1',
  };
}
