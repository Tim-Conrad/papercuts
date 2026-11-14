// Settings for the relay and the CLI. The env wins over the file that `papercuts setup` writes.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.4.1';

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

// The GitHub that the relay and the CLI talk to. Another host (GitHub Enterprise Server, or a
// gateway such as https://gh.gate that adds the token on the way out) uses the Enterprise URL layout.
export function githubHost(host = 'github.com') {
  if (!/^[A-Za-z0-9.-]+(:[0-9]+)?$/.test(host)) throw new Error(`PAPERCUTS_GITHUB_HOST must be a host name such as ghe.example.com, not "${host}"`);
  if (host === 'github.com') return { host, apiBase: 'https://api.github.com', uploadBase: 'https://uploads.github.com', assetHosts: ['github.com'] };
  return { host, apiBase: `https://${host}/api/v3`, uploadBase: `https://${host}/api/uploads`, assetHosts: [host] };
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

// With the local store, the relay runs next to a dev server: localhost origins and any repo name by default.
export function loadConfig(env = process.env, file = {}, { store = 'github' } = {}) {
  const local = store === 'local';
  const mode = env.PAPERCUTS_TARGET || file.target || 'per-project';
  if (!['per-project', 'central'].includes(mode)) throw new Error(`PAPERCUTS_TARGET must be per-project or central, not "${mode}"`);
  const target = { mode };
  if (mode === 'central') {
    target.centralRepo = env.PAPERCUTS_CENTRAL_REPO || file.centralRepo;
    if (!target.centralRepo) throw new Error('central target needs PAPERCUTS_CENTRAL_REPO (owner/name)');
  }
  const tokenFile = env.PAPERCUTS_TOKEN_FILE || file.tokenFile;
  const source = env.PAPERCUTS_CREDENTIAL || file.credential || (tokenFile ? 'file' : 'gh');
  if (!['gh', 'file'].includes(source)) throw new Error(`PAPERCUTS_CREDENTIAL must be gh or file, not "${source}"`);
  if (source === 'file' && !tokenFile) throw new Error('the file credential needs PAPERCUTS_TOKEN_FILE');
  const github = githubHost(env.PAPERCUTS_GITHUB_HOST ?? file.githubHost ?? 'github.com');
  const ghHost = github.host === 'github.com' ? {} : { host: github.host };
  return {
    origins: list(env.PAPERCUTS_ORIGINS || (local ? 'http://localhost,http://localhost:*,http://127.0.0.1,http://127.0.0.1:*' : 'https://*.lab.t7d.dev')),
    repos: list(env.PAPERCUTS_REPOS || (local ? '*/*' : 'Tim-Conrad/*')),
    store,
    target,
    credential: source === 'file' ? { source: 'file', path: tokenFile } : { source: 'gh', ...(env.PAPERCUTS_GH_MOUNT ? { mount: env.PAPERCUTS_GH_MOUNT } : {}), ...ghHost },
    github,
    port: Number(env.PORT || 8000),
    listCacheMs: Number(env.PAPERCUTS_LIST_CACHE_MS ?? 30000),
    configCacheMs: Number(env.PAPERCUTS_CONFIG_CACHE_MS ?? 300000),
    shotsDir: env.PAPERCUTS_SHOTS_DIR || file.shotsDir || 'shots',
    publicUrl: env.PAPERCUTS_PUBLIC_URL || file.publicUrl || '',
  };
}
