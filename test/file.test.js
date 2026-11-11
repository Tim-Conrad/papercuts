import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeGithub } from './fake-github.js';
import { githubClient } from '../src/github.js';
import { credentialFrom } from '../src/credential.js';
import { fileReport } from '../src/file.js';
import { normalizeReport } from '../src/format.js';
import { shotStore } from '../src/shots.js';
import { existsSync } from 'node:fs';

let gh, client;
const PER = { mode: 'per-project' };
const rep = (over = {}, from = 'agent') => normalizeReport({ kind: 'tool', text: 'gh-axi drops the body', repo: 'a/b', where: 'gh-axi pr view', ...over }, from).report;

beforeEach(async () => {
  gh = await fakeGithub();
  client = githubClient({ credential: { token: async () => gh.token, describe: () => 'test' }, apiBase: gh.apiBase, uploadBase: gh.apiBase });
});
afterEach(() => gh.close());

test('creates issue with labels', async () => {
  const r = await fileReport(rep({}, 'human'), { client, target: PER });
  assert.equal(r.ok, true);
  assert.equal(r.deduped, false);
  assert.equal(r.repo, 'a/b');
  assert.equal(gh.state.issues['a/b'].length, 1);
  assert.deepEqual(gh.state.issues['a/b'][0].labels.map((l) => l.name), ['papercut', 'from:human', 'kind:tool']);
  assert.match(r.url, /issues\/1$/);
});

test('same id returns first issue', async () => {
  const report = rep({}, 'human');
  const a = await fileReport(report, { client, target: PER });
  const b = await fileReport(report, { client, target: PER });
  assert.equal(b.issue, a.issue);
  assert.equal(gh.state.issues['a/b'].length, 1);
});

test('agent repeat adds +1', async () => {
  const a = await fileReport(rep(), { client, target: PER });
  const b = await fileReport(rep({ text: 'GH-AXI drops  the body' }), { client, target: PER });
  assert.equal(gh.state.issues['a/b'].length, 1);
  assert.equal(b.issue, a.issue);
  assert.equal(b.deduped, true);
  assert.match(gh.state.issues['a/b'][0].commentList[0], /^\+1/);
});

test('agent repeat within seconds adds +1 although GitHub lists lag', async () => {
  gh.state.lag = true;
  const a = await fileReport(rep(), { client, target: PER });
  const b = await fileReport(rep(), { client, target: PER });
  assert.equal(gh.state.issues['a/b'].length, 1);
  assert.equal(b.issue, a.issue);
  assert.equal(b.deduped, true);
});

test('retry of the same id within seconds returns the first issue although GitHub lists lag', async () => {
  gh.state.lag = true;
  const report = rep({}, 'human');
  const a = await fileReport(report, { client, target: PER });
  const b = await fileReport(report, { client, target: PER });
  assert.equal(b.issue, a.issue);
  assert.equal(gh.state.issues['a/b'].length, 1);
});

test('human repeat opens new issue', async () => {
  await fileReport(rep({}, 'human'), { client, target: PER });
  await fileReport(rep({}, 'human'), { client, target: PER });
  assert.equal(gh.state.issues['a/b'].length, 2);
});

test('closed fp opens new issue', async () => {
  await fileReport(rep(), { client, target: PER });
  gh.state.issues['a/b'][0].state = 'closed';
  const b = await fileReport(rep(), { client, target: PER });
  assert.equal(b.deduped, false);
  assert.equal(gh.state.issues['a/b'].length, 2);
});

test('central mode', async () => {
  const r = await fileReport(rep(), { client, target: { mode: 'central', centralRepo: 'Tim-Conrad/inbox' } });
  assert.equal(r.repo, 'Tim-Conrad/inbox');
  assert.ok(gh.state.issues['Tim-Conrad/inbox'][0].labels.some((l) => l.name === 'project:a/b'));
});

test('token never in error', async () => {
  gh.state.fail = 401;
  const r = await fileReport(rep(), { client, target: PER });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(gh.token), JSON.stringify(r));
  assert.match(r.error, /^github: 401/);
});

test('token only in authorization header', async () => {
  await fileReport(rep(), { client, target: PER });
  for (const q of gh.state.requests) {
    assert.ok(!q.path.includes(gh.token) && !q.query.includes(gh.token));
    assert.equal(q.auth, `Bearer ${gh.token}`);
  }
});

test('file credential trims, describe hides token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'));
  writeFileSync(join(dir, 't'), 'abc123\n');
  const c = credentialFrom({ source: 'file', path: join(dir, 't') });
  assert.equal(await c.token(), 'abc123');
  assert.ok(!c.describe().includes('abc123'));
});

test('broker credential is not implemented', async () => {
  const c = credentialFrom({ source: 'broker', socket: '/x' });
  await assert.rejects(c.token(), /not implemented in v0.1/);
});

test('401 clears the cached token and retries once', async () => {
  let calls = 0;
  const c = githubClient({ credential: { token: async () => { calls++; return gh.token; }, describe: () => 'test' }, apiBase: gh.apiBase });
  await c.user();
  gh.state.failOnce = 401;
  const me = await c.user();
  assert.equal(me.login, 'tester');
  assert.equal(calls, 2);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const withShot = () => normalizeReport({ kind: 'ux', text: 'see picture', repo: 'a/b', shot: 'data:image/png;base64,' + PNG.toString('base64') }, 'human').report;

test('uploads the picture and embeds it', async () => {
  const r = await fileReport(withShot(), { client, target: PER });
  assert.equal(r.ok, true);
  assert.equal(gh.state.uploads.length, 1);
  assert.equal(gh.state.uploads[0].query.repository_id, '4242');
  assert.equal(gh.state.uploads[0].type, 'image/png');
  assert.match(gh.state.issues['a/b'][0].body, /!\[papercut\]\(https:\/\/github\.com\/user-attachments\/assets\/fake-1\)/);
});

test('upload 404 falls back to the relay link', async () => {
  gh.state.uploadFail = 404;
  const dir = mkdtempSync(join(tmpdir(), 'pc-shots-'));
  const report = withShot();
  const r = await fileReport(report, { client, target: PER, shots: shotStore(dir), publicUrl: 'https://papercuts.lab.example' });
  assert.equal(r.ok, true);
  assert.ok(gh.state.issues['a/b'][0].body.includes(`https://papercuts.lab.example/shots/${report.id}.png`));
  assert.ok(existsSync(join(dir, `${report.id}.png`)));
});

test('upload fails and no store: the issue still goes out, with a note', async () => {
  gh.state.uploadFail = 404;
  const r = await fileReport(withShot(), { client, target: PER });
  assert.equal(r.ok, true);
  assert.match(gh.state.issues['a/b'][0].body, /picture could not be saved/);
});

test('retry with the same id does not upload twice', async () => {
  const report = withShot();
  await fileReport(report, { client, target: PER });
  await fileReport(report, { client, target: PER });
  assert.equal(gh.state.uploads.length, 1);
  assert.equal(gh.state.issues['a/b'].length, 1);
});
