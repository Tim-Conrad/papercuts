// Reports from native apps: app tokens on /app-report, and text attachments as issue comments.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeGithub } from './fake-github.js';
import { githubClient } from '../src/github.js';
import { createRelay, appFor } from '../src/relay.js';
import { loadConfig, readAppTokens } from '../src/config.js';
import { attachmentComment, normalizeReport, parseAttachment, LIMITS } from '../src/format.js';
import { run } from '../src/cli.js';

const TOKEN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SERVER = 'd'.repeat(40);
let gh, client, relay, base, dir;

beforeEach(async () => {
  gh = await fakeGithub();
  client = githubClient({ credential: { token: async () => gh.token, describe: () => 't' }, apiBase: gh.apiBase });
  dir = mkdtempSync(join(tmpdir(), 'pc-app-'));
  writeFileSync(join(dir, 'tokens'), `# label token repos\nclaude-auto ${TOKEN} Tim-Conrad/claude-auto\nshort tooshort Tim-Conrad/x\nother ${OTHER} Tim-Conrad/other,Tim-Conrad/shop\nserver ${SERVER} Tim-Conrad/claude-auto agent\nodd ${'e'.repeat(40)} Tim-Conrad/x admin\n`);
  const config = loadConfig({ PAPERCUTS_REPOS: 'Tim-Conrad/*', PAPERCUTS_SHOTS_DIR: join(dir, 'shots'), PAPERCUTS_PUBLIC_URL: 'https://papercuts.lab.example', PAPERCUTS_APP_TOKENS_FILE: join(dir, 'tokens') });
  relay = createRelay(config, { client });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${relay.address().port}`;
});
afterEach(async () => { await new Promise((r) => relay.close(r)); await gh.close(); });

const report = (over = {}) => ({ report: { kind: 'bug', text: 'Chat menu does nothing', repo: 'Tim-Conrad/claude-auto', ...over } });
const appPost = (payload, { token = TOKEN, type = 'application/json', path = '/app-report' } = {}) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload),
});
const issues = () => gh.state.issues['Tim-Conrad/claude-auto'] || [];

test('attachment comment round trip survives backtick fences in the text', () => {
  const text = '<div>```js\nx\n```</div>\n````\nend';
  const back = parseAttachment(attachmentComment({ name: 'dom.html', text }));
  assert.deepEqual(back, { name: 'dom.html', text });
  assert.equal(parseAttachment('just a reply'), null);
});

test('attachments are checked: name, count, size', () => {
  const ok = normalizeReport({ kind: 'bug', text: 't', repo: 'a/b', attachments: [{ name: 'dom.html', text: '<p>' }] }, 'human');
  assert.equal(ok.report.attachments[0].name, 'dom.html');
  const bad = (attachments) => normalizeReport({ kind: 'bug', text: 't', repo: 'a/b', attachments }, 'human').ok;
  assert.equal(bad([{ name: '../x', text: 'a' }]), false);
  assert.equal(bad([{ name: 'a.txt', text: 'a' }, { name: 'a.txt', text: 'b' }]), false);
  assert.equal(bad([{ name: 'a.txt', text: '' }]), false);
  assert.equal(bad([{ name: 'a.txt', text: 'x'.repeat(LIMITS.attachment + 1) }]), false);
  assert.equal(bad(Array.from({ length: LIMITS.attachments + 1 }, (_, i) => ({ name: `a${i}.txt`, text: 'a' }))), false);
});

test('app tokens: short tokens are ignored, a missing file means none', () => {
  const t = readAppTokens(join(dir, 'tokens'));
  assert.deepEqual(t.map((x) => x.label), ['claude-auto', 'other', 'server']);
  assert.deepEqual(t.map((x) => x.agent), [false, false, true]);
  assert.deepEqual(readAppTokens(join(dir, 'nope')), []);
  assert.deepEqual(readAppTokens(''), []);
  assert.equal(appFor(`Bearer ${TOKEN}`, t).label, 'claude-auto');
  assert.equal(appFor(`Bearer ${'c'.repeat(40)}`, t), null);
  assert.equal(appFor(TOKEN, t), null);
});

test('/app-report files the issue and one comment per attachment', async () => {
  const res = await appPost(report({ context: { phase: 'READY', events: ['start aa_chat', 'notfound /chat/[Chat 1]'] },
    attachments: [{ name: 'dom.html', text: '<button aria-label="Use voice mode"></button>' }] }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(issues().length, 1);
  assert.match(issues()[0].body, /notfound/);
  assert.match(issues()[0].body, /from: human/);
  assert.equal(issues()[0].commentList.length, 1);
  assert.equal(parseAttachment(issues()[0].commentList[0]).text, '<button aria-label="Use voice mode"></button>');
});

test('/app-report needs a valid token and stays inside its repos', async () => {
  assert.equal((await appPost(report(), { token: null })).status, 401);
  assert.equal((await appPost(report(), { token: 'c'.repeat(40) })).status, 401);
  assert.equal((await appPost(report({ repo: 'Tim-Conrad/shop' }))).status, 403);
  assert.equal((await appPost(report(), { token: OTHER })).status, 403);
  assert.equal(issues().length, 0);
});

test('/app-report: a setup problem keeps the report on the phone (retry true)', async () => {
  const other = await appPost(report({ repo: 'Tim-Conrad/shop' }));
  assert.equal(other.status, 403);
  assert.equal((await other.json()).retry, true);
  gh.state.fail = 404;
  const res = await appPost(report());
  const body = await res.json();
  assert.equal(res.status, 502, JSON.stringify(body));
  assert.equal(body.retry, true);
  assert.match(body.error, /404/);
  gh.state.fail = 0;
  assert.equal((await appPost(report())).status, 200);
  assert.equal(issues().length, 1);
});

test('/app-report: a bad report is still final (retry false)', async () => {
  const res = await appPost(report({ kind: 'nope', text: '' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).retry, false);
});

test('/app-report ignores a claimed agent source', async () => {
  const res = await appPost({ from: 'agent', ...report() });
  assert.equal(res.status, 200);
  assert.match(issues()[0].body, /from: human/);
});

test('/app-report: a token with "agent" on its line may file as an agent', async () => {
  const res = await appPost({ from: 'agent', ...report() }, { token: SERVER });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.match(issues()[0].body, /from: agent/);
});

test('/app-report: an agent token without a from field still files as human', async () => {
  assert.equal((await appPost(report(), { token: SERVER })).status, 200);
  assert.match(issues()[0].body, /from: human/);
});

test('/report still needs an allowed origin, a token does not replace it', async () => {
  const res = await appPost({ from: 'human', ...report() }, { path: '/report', type: 'text/plain' });
  assert.equal(res.status, 403);
});

test('CLI: view names the attachments, attachment saves one', async () => {
  await appPost(report({ attachments: [{ name: 'dom.html', text: '<main></main>' }, { name: 'events.txt', text: 'start' }] }));
  const cwd = mkdtempSync(join(tmpdir(), 'pc-repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Tim-Conrad/claude-auto.git'], { cwd });
  const cli = async (...argv) => {
    let out = '';
    const code = await run(argv, { env: { HOME: dir }, cwd, client, stdout: { write: (s) => { out += s; } } });
    return { code, out };
  };
  const n = String(issues()[0].number);
  const v = await cli('view', n);
  assert.match(v.out, /attachments: dom.html events.txt/);
  const list = await cli('attachment', n);
  assert.equal(list.code, 0);
  assert.match(list.out, /events.txt/);
  const one = await cli('attachment', n, 'dom.html');
  assert.equal(one.code, 0, one.out);
  assert.equal(readFileSync(join(cwd, `papercut-${n}-dom.html`), 'utf8'), '<main></main>');
  assert.equal((await cli('attachment', n, 'nope.txt')).code, 1);
});
