// The local store: papercuts in a SQLite file of the repo (.papercuts/papercuts.db, gitignored) instead of GitHub issues.
// The client has the same methods as the GitHub client, so filing, the list, the hook and the relay work unchanged.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { GithubError } from './github.js';
import { CONFIG_PATH } from './ticket.js';
import { repoFromGit } from './repo.js';

export const STORE_DIR = '.papercuts';
export const DB_NAME = 'papercuts.db';
export const STORES = ['github', 'local'];

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

// The checkout of this folder, and the main checkout: a worktree shares the database of the main checkout.
export function checkouts(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common && basename(common) === '.git' ? dirname(common) : top;
  return { top: top || cwd, main: main || top || cwd, isGit: Boolean(top) };
}

export function readStoreSetting(dir) {
  try {
    const store = JSON.parse(readFileSync(join(dir, CONFIG_PATH), 'utf8')).store;
    return STORES.includes(store) ? store : null;
  } catch {
    return null;
  }
}

// Where the papercuts of this folder go. PAPERCUTS_STORE wins, then "store" in .github/papercuts.json.
// A --repo for another repo always goes to GitHub: the local file belongs to this checkout only.
export function storeFor(cwd, env = {}, { repoFlag, ownRepo } = {}) {
  const { top, main, isGit } = checkouts(cwd);
  const dbPath = env.PAPERCUTS_DB ? resolve(cwd, env.PAPERCUTS_DB) : join(main, STORE_DIR, DB_NAME);
  if (repoFlag && repoFlag !== (ownRepo === undefined ? repoFromGit(cwd) : ownRepo)) return { mode: 'github', root: top, main, dbPath, isGit };
  const fromEnv = STORES.includes(env.PAPERCUTS_STORE) ? env.PAPERCUTS_STORE : null;
  const mode = fromEnv || (isGit || existsSync(join(cwd, CONFIG_PATH)) ? readStoreSetting(top) : null) || 'github';
  return { mode, root: top, main, dbPath, isGit };
}

// The repo name of a local store without a GitHub remote: local/<folder of the main checkout>.
export function localRepoName(dir) {
  return `local/${basename(dir).replace(/[^A-Za-z0-9_.-]/g, '-') || 'repo'}`;
}

let sqlite;
function openDb(path) {
  if (!sqlite) {
    // node:sqlite is built in since Node 22.13. It prints an ExperimentalWarning once; papercuts output stays clean.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => (/SQLite/.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
    try { sqlite = createRequire(import.meta.url)('node:sqlite'); } finally { process.emitWarning = emit; }
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new sqlite.DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS papercuts (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      labels TEXT NOT NULL DEFAULT '[]',
      assignees TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      papercut INTEGER NOT NULL REFERENCES papercuts(number),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS papercuts_repo_state ON papercuts(repo, state);`);
  return db;
}

const notFound = (what) => Object.assign(new GithubError(404, `no ${what} in the local store`), { source: 'local' });
const SHOT = /^[A-Za-z0-9_.-]{1,80}\.png$/;

export function localClient({ dbPath, root }) {
  const db = openDb(dbPath);
  const shotsDir = join(dirname(dbPath), 'shots');
  const now = () => new Date().toISOString();
  const countOf = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE papercut = ?');
  const toIssue = (row) => ({
    number: row.number,
    title: row.title,
    body: row.body,
    labels: JSON.parse(row.labels).map((name) => ({ name })),
    assignees: JSON.parse(row.assignees).map((login) => ({ login })),
    state: row.state,
    created_at: row.created_at,
    closed_at: row.closed_at,
    comments: countOf.get(row.number).n,
    html_url: `${pathToFileURL(dbPath).href}#${row.number}`,
  });
  // A label filter like GitHub's: "papercut,project:x" needs every label.
  const withLabels = (rows, label) => {
    const want = String(label || '').split(',').filter(Boolean);
    return rows.filter((r) => { const names = JSON.parse(r.labels); return want.every((w) => names.includes(w)); }).map(toIssue);
  };
  const row = (repo, n) => {
    const r = db.prepare('SELECT * FROM papercuts WHERE repo = ? AND number = ?').get(repo, n);
    if (!r) throw notFound(`papercut #${n} of ${repo}`);
    return r;
  };
  const addComment = (n, body) => db.prepare('INSERT INTO comments (papercut, body, created_at) VALUES (?, ?, ?)').run(n, body, now());

  return {
    kind: 'local',
    dbPath,
    user: async () => ({ login: (() => { try { return userInfo().username; } catch { return 'local'; } })() }),
    repo: async (repo) => ({ full_name: repo, permissions: { push: true } }),
    listOpen: async (repo, label) => withLabels(db.prepare("SELECT * FROM papercuts WHERE repo = ? AND state = 'open' ORDER BY number DESC").all(repo), label),
    listClosedSince: async (repo, label, since) => withLabels(db.prepare("SELECT * FROM papercuts WHERE repo = ? AND state = 'closed' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 100").all(repo, since), label),
    listRecent: async (repo, label, n = 100) => withLabels(db.prepare('SELECT * FROM papercuts WHERE repo = ? ORDER BY number DESC LIMIT ?').all(repo, n), label),
    getIssue: async (repo, n) => toIssue(row(repo, n)),
    comments: async (repo, n) => {
      row(repo, n);
      return db.prepare('SELECT body, created_at FROM comments WHERE papercut = ? ORDER BY id').all(n).map((c) => ({ body: c.body, created_at: c.created_at }));
    },
    createIssue: async (repo, issue) => {
      const r = db.prepare('INSERT INTO papercuts (repo, title, body, labels, assignees, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(repo, issue.title, issue.body, JSON.stringify(issue.labels || []), JSON.stringify(issue.assignees || []), now());
      return toIssue(row(repo, Number(r.lastInsertRowid)));
    },
    comment: async (repo, n, body) => { row(repo, n); addComment(n, body); return { body }; },
    close: async (repo, n, comment) => {
      row(repo, n);
      if (comment) addComment(n, comment);
      db.prepare("UPDATE papercuts SET state = 'closed', closed_at = ? WHERE number = ?").run(now(), n);
      return toIssue(row(repo, n));
    },
    ensureLabels: async () => {},
    // The config comes from the working tree, so a change counts at once. Only files inside the checkout.
    async getFile(_repo, path) {
      const file = resolve(root, path);
      if (!file.startsWith(resolve(root) + sep)) return null;
      try { return readFileSync(file, 'utf8'); } catch { return null; }
    },
    async uploadAsset(_repo, buffer, name) {
      if (!SHOT.test(name)) throw new GithubError(0, 'bad picture name');
      mkdirSync(shotsDir, { recursive: true });
      const file = join(shotsDir, name);
      writeFileSync(file, buffer);
      return { url: pathToFileURL(file).href };
    },
    async download(url) {
      let file;
      try { file = fileURLToPath(url); } catch { throw new GithubError(0, `the local store reads only its own pictures, not ${url}`); }
      if (dirname(file) !== shotsDir || !SHOT.test(basename(file))) throw new GithubError(0, `the local store reads only pictures in ${shotsDir}`);
      try { return readFileSync(file); } catch { throw notFound(`picture ${basename(file)}`); }
    },
  };
}
