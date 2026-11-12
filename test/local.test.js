// The local store: papercuts in a gitignored SQLite file of the repo instead of GitHub issues.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeGithub } from './fake-github.js';
import { githubClient } from '../src/github.js';
import { run } from '../src/cli.js';
import { localClient, storeFor } from '../src/store.js';
import { fileReport } from '../src/file.js';
import { normalizeReport } from '../src/format.js';
import { createRelay } from '../src/relay.js';
import { loadConfig } from '../src/config.js';
import { checkConfig } from '../src/ticket.js';

let gh, client, home, cwd;
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

function localRepo({ remote = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-local-'));
  git(dir, 'init', '-q');
  if (remote) git(dir, 'remote', 'add', 'origin', 'git@github.com:Tim-Conrad/shop.git');
  mkdirSync(join(dir, '.github'));
  writeFileSync(join(dir, '.github', 'papercuts.json'), JSON.stringify({ store: 'local', labels: ['area:web'] }));
  writeFileSync(join(dir, '.gitignore'), '.papercuts/\n');
  return dir;
}

beforeEach(async () => {
  gh = await fakeGithub();
  client = githubClient({ credential: { token: async () => gh.token, describe: () => 'test' }, apiBase: gh.apiBase });
  home = mkdtempSync(join(tmpdir(), 'pc-home-'));
  cwd = localRepo();
});
afterEach(() => gh.close());

async function cli(argv, { dir = cwd, env = {} } = {}) {
  let out = '';
  const code = await run(argv, { env: { HOME: home, ...env }, cwd: dir, client, stdout: { write: (s) => { out += s; } } });
  return { code, out };
}

test('the ticket config takes store github or local', () => {
  assert.equal(checkConfig({ store: 'local' }).config.store, 'local');
  assert.equal(checkConfig({}).config.store, 'github');
  const bad = checkConfig({ store: 'sqlite' });
  assert.equal(bad.config.store, 'github');
  assert.match(bad.warnings.join(), /store must be "github" or "local"/);
});

test('storeFor reads the store of the repo, and the env and --repo win', () => {
  const s = storeFor(cwd, {});
  assert.equal(s.mode, 'local');
  assert.equal(s.dbPath, join(cwd, '.papercuts', 'papercuts.db'));
  assert.equal(storeFor(cwd, { PAPERCUTS_STORE: 'github' }).mode, 'github');
  assert.equal(storeFor(cwd, {}, { repoFlag: 'Tim-Conrad/other' }).mode, 'github');
  assert.equal(storeFor(cwd, {}, { repoFlag: 'Tim-Conrad/shop' }).mode, 'local');
  assert.equal(storeFor(home, {}).mode, 'github');
});

test('a worktree uses the database of the main checkout', () => {
  git(cwd, 'add', '.');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd });
  const wt = join(mkdtempSync(join(tmpdir(), 'pc-wt-')), 'wt');
  git(cwd, 'worktree', 'add', '-q', wt);
  assert.equal(storeFor(wt, {}).dbPath, join(cwd, '.papercuts', 'papercuts.db'));
});

test('the local client files, dedupes and closes like GitHub', async () => {
  const db = join(cwd, '.papercuts', 'papercuts.db');
  const local = localClient({ dbPath: db, root: cwd });
  const rep = (text, from = 'agent') => normalizeReport({ kind: 'tool', text, where: 'gh-axi', repo: 'Tim-Conrad/shop' }, from).report;
  const a = await fileReport(rep('gh-axi drops the body'), { client: local, config: { labels: ['area:web'] } });
  assert.equal(a.ok, true);
  assert.equal(a.issue, 1);
  const b = await fileReport(rep('GH-AXI drops the body'), { client: local, config: {} });
  assert.equal(b.deduped, true);
  assert.equal(b.issue, 1);
  const human = rep('page is slow', 'human');
  const c = await fileReport(human, { client: local, config: {} });
  assert.equal((await fileReport(human, { client: local, config: {} })).issue, c.issue);
  const open = await local.listOpen('Tim-Conrad/shop', 'papercut');
  assert.equal(open.length, 2);
  const one = await local.getIssue('Tim-Conrad/shop', 1);
  assert.deepEqual(one.labels.map((l) => l.name).sort(), ['area:web', 'from:agent', 'kind:tool', 'papercut']);
  assert.equal(one.comments, 1);
  await local.close('Tim-Conrad/shop', 1, 'Fixed: abc');
  assert.equal((await local.getIssue('Tim-Conrad/shop', 1)).state, 'closed');
  assert.equal((await local.listOpen('Tim-Conrad/shop', 'papercut')).length, 1);
  const closed = await local.listClosedSince('Tim-Conrad/shop', 'papercut', new Date(Date.now() - 60000).toISOString());
  assert.deepEqual(closed.map((i) => i.number), [1]);
  await assert.rejects(local.getIssue('Tim-Conrad/shop', 99), (e) => e.status === 404 && e.source === 'local');
  assert.equal(await local.getFile('Tim-Conrad/shop', '.github/papercuts.json'), readFileSync(join(cwd, '.github', 'papercuts.json'), 'utf8'));
  assert.equal(await local.getFile('Tim-Conrad/shop', '../../etc/passwd'), null);
});

test('pictures go to the shots folder of the store and come back with download', async () => {
  const db = join(cwd, '.papercuts', 'papercuts.db');
  const local = localClient({ dbPath: db, root: cwd });
  const png = Buffer.from('89504e470d0a1a0a00', 'hex');
  const { url } = await local.uploadAsset('Tim-Conrad/shop', png, 'papercut-abc.png');
  assert.ok(url.startsWith('file://'), url);
  assert.ok(existsSync(join(cwd, '.papercuts', 'shots', 'papercut-abc.png')));
  assert.deepEqual(await local.download(url), png);
  await assert.rejects(local.download('file:///etc/passwd'));
  await assert.rejects(local.download('https://github.com/x.png'));
});

test('CLI: add, home, list, view and done use the local file and never call GitHub', async () => {
  const before = gh.state.requests.length;
  let r = await cli(['add', 'tool', 'gh-axi drops the body', '--where', 'gh-axi']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^papercut: #1 created$/m);
  assert.match(r.out, /^store: local \.papercuts\/papercuts\.db$/m);
  assert.ok(existsSync(join(cwd, '.papercuts', 'papercuts.db')));
  r = await cli([]);
  assert.match(r.out, /^repo: Tim-Conrad\/shop \(local store\)$/m);
  assert.match(r.out, /1,tool,agent,gh-axi drops the body,1/);
  r = await cli(['list', '--fields', 'url']);
  assert.match(r.out, /1,tool,agent,gh-axi drops the body,1,/);
  r = await cli(['view', '1']);
  assert.match(r.out, /state: open/);
  assert.match(r.out, /area:web/);
  r = await cli(['done', '1', '--fix', 'gh-axi 1.2 prints the body']);
  assert.match(r.out, /^papercut: #1 closed/m);
  r = await cli(['view', '1']);
  assert.match(r.out, /state: closed/);
  r = await cli(['view', '7']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^error: local: 404/m);
  assert.equal(gh.state.requests.length, before);
});

test('CLI: the session hook shows local papercuts', async () => {
  await cli(['add', 'rule', 'Two rules disagree']);
  const r = await cli(['--hook']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Two rules disagree/);
  assert.match(r.out, /^count: 1 open in Tim-Conrad\/shop \(local store\)$/m);
});

test('CLI: a local repo without a GitHub remote works', async () => {
  const dir = localRepo({ remote: false });
  const r = await cli(['add', 'tool', 'no remote here'], { dir });
  assert.equal(r.code, 0, r.out);
  const home2 = await cli([], { dir });
  assert.match(home2.out, new RegExp(`^repo: local/${basename(dir).replace(/[^A-Za-z0-9_.-]/g, '-')} \\(local store\\)$`, 'm'));
});

test('CLI: doctor checks the local file and the gitignore', async () => {
  let r = await cli(['doctor']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /store,ok/);
  assert.match(r.out, /gitignored,ok/);
  writeFileSync(join(cwd, '.gitignore'), '');
  r = await cli(['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /gitignored,fail/);
});

test('init --store local writes the store, the gitignore line and the local relay command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-init-local-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const r = await cli(['init', '--store', 'local'], { dir });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(readFileSync(join(dir, '.github', 'papercuts.json'), 'utf8')).store, 'local');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.papercuts/\n');
  assert.match(r.out, /^store: local/m);
  assert.match(r.out, /papercuts serve/);
  const again = await cli(['init', '--store', 'local'], { dir });
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.papercuts/\n');
  assert.match(again.out, /\.gitignore: has \.papercuts\/, not changed/);
  const bad = await cli(['init', '--store', 'sqlite'], { dir });
  assert.equal(bad.code, 2);
});

test('init --store local sets the store in an existing config and keeps the rest', async () => {
  writeFileSync(join(cwd, '.github', 'papercuts.json'), JSON.stringify({ labels: ['x'] }, null, 2) + '\n');
  const r = await cli(['init', '--store', 'local']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.github', 'papercuts.json'), 'utf8')), { labels: ['x'], store: 'local' });
});

test('relay: with the local store, reports from the widget go to the file and show in the list', async () => {
  const db = join(cwd, '.papercuts', 'papercuts.db');
  const config = loadConfig({}, {}, { store: 'local' });
  assert.ok(config.origins.includes('http://localhost:*'));
  const relay = createRelay(config, { client: localClient({ dbPath: db, root: cwd }) });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.address().port}`;
  try {
    const origin = 'http://localhost:5173';
    const res = await fetch(base + '/report', { method: 'POST', headers: { 'content-type': 'text/plain', origin },
      body: JSON.stringify({ from: 'human', report: { kind: 'bug', text: 'button overlaps', repo: 'local/my-site' } }) });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.issue, 1);
    const list = await (await fetch(base + '/list?repo=local/my-site', { headers: { origin } })).json();
    assert.deepEqual(list.items.map((i) => i.title), ['button overlaps']);
    const cfg = await (await fetch(base + '/config?repo=local/my-site', { headers: { origin } })).json();
    assert.deepEqual(cfg.config.labels, ['area:web']);
    assert.equal(gh.state.requests.length, 0);
  } finally {
    await new Promise((r) => relay.close(r));
  }
});

test('CLI: comment adds a note to a local papercut, and the list counts it as a reply', async () => {
  await cli(['add', 'rule', 'Two rules disagree']);
  const r = await cli(['comment', '1', 'Option A: keep rule 1. Option B: keep rule 2.']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^papercut: comment added to #1$/m);
  const local = localClient({ dbPath: join(cwd, '.papercuts', 'papercuts.db'), root: cwd });
  assert.deepEqual((await local.comments('Tim-Conrad/shop', 1)).map((c) => c.body), ['Option A: keep rule 1. Option B: keep rule 2.']);
  assert.equal((await cli(['comment', '1', ''])).code, 2);
});

// Review findings (final review of the local store).
test('review: the AGENTS block keeps a H1 after it, a user section under it, and code fences', async () => {
  const user = '# Agents\n\n```md\n## Papercuts\nexample\n```\n\n## Papercuts\n\nReport friction with papercuts. Old.\n\n- old bullet\n\n### Local notes\n\nMine.\n\n# Appendix\n\nUser appendix.\n';
  writeFileSync(join(cwd, 'AGENTS.md'), user);
  await cli(['init']);
  const text = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  for (const keep of ['```md\n## Papercuts\nexample\n```', '### Local notes\n\nMine.', '# Appendix\n\nUser appendix.']) assert.ok(text.includes(keep), keep);
  assert.ok(!text.includes('old bullet'));
  assert.ok(text.includes('<!-- papercuts:begin -->') && text.includes('### Integration'));
  const again = await cli(['init']);
  assert.match(again.out, /has the current papercuts block/);
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), text);
});

test('review: CRLF and a trailing space on the heading do not add a second block', async () => {
  writeFileSync(join(cwd, 'AGENTS.md'), '# Agents\r\n\r\n## Papercuts \r\n\r\nReport friction with papercuts. Old.\r\n');
  await cli(['init']);
  const text = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.equal((text.match(/^## Papercuts/gm) || []).length, 1);
  assert.ok(!/[^\r]\n/.test(text), 'keeps CRLF');
});

test('review: init in a worktree ignores the database of the main checkout', async () => {
  writeFileSync(join(cwd, '.gitignore'), '');
  git(cwd, 'add', '.');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd });
  const wt = join(mkdtempSync(join(tmpdir(), 'pc-wt-')), 'wt');
  git(cwd, 'worktree', 'add', '-q', wt);
  await cli(['init', '--store', 'local'], { dir: wt });
  await cli(['add', 'tool', 'from the worktree'], { dir: wt });
  assert.equal(git(cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal((await cli(['doctor'], { dir: wt })).code, 0);
});

test('review: init in a subfolder writes the config at the top of the checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-sub-'));
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'sub'));
  await cli(['init', '--store', 'local'], { dir: join(dir, 'sub') });
  assert.ok(existsSync(join(dir, '.github', 'papercuts.json')));
  assert.ok(!existsSync(join(dir, 'sub', '.github')));
  const r = await cli(['add', 'tool', 'from a subfolder'], { dir: join(dir, 'sub') });
  assert.equal(r.code, 0, r.out);
});

test('review: a remote added later does not hide local papercuts', async () => {
  const dir = localRepo({ remote: false });
  await cli(['add', 'tool', 'before the remote'], { dir });
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
  const r = await cli(['list'], { dir });
  assert.match(r.out, /before the remote/);
  assert.match((await cli(['view', '1'], { dir })).out, /state: open/);
});

test('review: a database error is a local error that the relay can retry', async () => {
  const local = localClient({ dbPath: join(cwd, '.papercuts', 'papercuts.db'), root: cwd });
  const rep = normalizeReport({ kind: 'tool', text: 'x', repo: 'Tim-Conrad/shop' }, 'agent').report;
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(join(cwd, '.papercuts', 'papercuts.db')).exec('DROP TABLE comments; DROP TABLE papercuts;');
  const r = await fileReport(rep, { client: local, config: {} });
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  assert.match(r.error, /^local: /);
});

test('review: the local relay accepts localhost without a port', () => {
  const { origins } = loadConfig({}, {}, { store: 'local' });
  for (const o of ['http://localhost', 'http://localhost:5173', 'http://127.0.0.1:8000']) assert.ok(origins.some((g) => new RegExp(`^${g.replace(/[.]/g, '\\.').replace('*', '[^./:]+')}$`).test(o)), o);
});
