import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGithub } from './fake-github.js';
import { githubClient } from '../src/github.js';
import { createRelay } from '../src/relay.js';
import { loadConfig, originAllowed } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let gh, relay, base, shotsDir;
const ALLOWED = 'https://shop.lab.t7d.dev';

beforeEach(async () => {
  gh = await fakeGithub();
  const client = githubClient({ credential: { token: async () => gh.token, describe: () => 't' }, apiBase: gh.apiBase });
  shotsDir = mkdtempSync(join(tmpdir(), 'pc-relay-shots-'));
  const config = loadConfig({ PAPERCUTS_REPOS: 'Tim-Conrad/*,x/one', PAPERCUTS_SHOTS_DIR: shotsDir, PAPERCUTS_PUBLIC_URL: 'https://papercuts.lab.example' });
  relay = createRelay(config, { client });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${relay.address().port}`;
});
afterEach(async () => { await new Promise((r) => relay.close(r)); await gh.close(); });

const post = (payload, { origin = ALLOWED, type = 'text/plain', raw } = {}) => fetch(base + '/report', {
  method: 'POST', headers: { 'content-type': type, ...(origin ? { origin } : {}) },
  body: raw ?? JSON.stringify(payload),
});
const report = (over = {}) => ({ from: 'human', report: { kind: 'bug', text: 'button overlaps', repo: 'Tim-Conrad/shop', ...over } });

test('serves widget no-cache', async () => {
  const res = await fetch(base + '/papercuts.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('rejects foreign origin', async () => {
  const res = await post(report(), { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://evil.example');
  assert.equal(gh.state.requests.length, 0);
});

test('rejects missing origin', async () => {
  const res = await post(report(), { origin: null });
  assert.equal(res.status, 403);
  assert.equal(gh.state.requests.length, 0);
});

test('rejects foreign repo', async () => {
  const res = await post(report({ repo: 'someone/else' }));
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.ok(data.help);
  assert.equal(gh.state.requests.length, 0);
});

test('rejects non-text content type', async () => {
  const res = await post(report(), { type: 'application/json' });
  assert.equal(res.status, 415);
});

test('rejects bad json and bad report with 400', async () => {
  assert.equal((await post(null, { raw: '{nope' })).status, 400);
  assert.equal((await post(report({ kind: 'nope' }))).status, 400);
});

test('cors only for allowed origin', async () => {
  const ok = await fetch(base + '/status', { headers: { origin: ALLOWED } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(ok.headers.get('vary'), 'Origin');
  const bad = await fetch(base + '/status', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('files report', async () => {
  const res = await post(report());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.issue, 1);
  assert.equal(gh.state.issues['Tim-Conrad/shop'].length, 1);
});

test('github failure is 502', async () => {
  gh.state.fail = 500;
  const res = await post(report());
  assert.equal(res.status, 502);
});

test('body too large', async () => {
  const res = await post(null, { raw: 'x'.repeat(13 * 1024 * 1024) });
  assert.equal(res.status, 413);
});

test('status and healthz', async () => {
  const s = await (await fetch(base + '/status', { headers: { origin: ALLOWED } })).json();
  assert.equal(s.ok, true);
  assert.equal(s.version, '0.1.0');
  assert.equal(await (await fetch(base + '/healthz')).text(), 'ok');
});

test('origin globs', () => {
  const o = ['https://*.lab.t7d.dev', 'http://localhost:*'];
  assert.equal(originAllowed('https://a.lab.t7d.dev', o), true);
  assert.equal(originAllowed('https://a.b.lab.t7d.dev', o), false);
  assert.equal(originAllowed('https://lab.t7d.dev.evil.com', o), false);
  assert.equal(originAllowed('http://localhost:5173', o), true);
  assert.equal(originAllowed('http://localhost', o), false);
});

test('config defaults', () => {
  const c = loadConfig({});
  assert.deepEqual(c.origins, ['https://*.lab.t7d.dev']);
  assert.deepEqual(c.repos, ['Tim-Conrad/*']);
  assert.deepEqual(c.target, { mode: 'per-project' });
  assert.deepEqual(c.credential, { source: 'gh' });
  assert.equal(c.port, 8000);
  const f = loadConfig({ PAPERCUTS_TOKEN_FILE: '/run/secrets/t', PAPERCUTS_TARGET: 'central', PAPERCUTS_CENTRAL_REPO: 'a/inbox' });
  assert.deepEqual(f.credential, { source: 'file', path: '/run/secrets/t' });
  assert.deepEqual(f.target, { mode: 'central', centralRepo: 'a/inbox' });
});

test('github 404 is a permanent 4xx with retry false', async () => {
  gh.state.fail = 404;
  const res = await post(report());
  assert.equal(res.status, 422);
  assert.equal((await res.json()).retry, false);
});

test('github 5xx stays 502 with retry true', async () => {
  gh.state.fail = 503;
  const res = await post(report());
  assert.equal(res.status, 502);
  assert.equal((await res.json()).retry, true);
});

test('foreign origin 403 carries cors so the browser can read it', async () => {
  const res = await post(report(), { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://evil.example');
  assert.equal((await res.json()).retry, false);
});

test('same id sent twice at once makes one issue', async () => {
  const body = report({ id: 'same-id-1' });
  const [a, b] = await Promise.all([post(body), post(body)]);
  const [da, db] = [await a.json(), await b.json()];
  assert.equal(da.issue, db.issue);
  assert.equal(gh.state.issues['Tim-Conrad/shop'].length, 1);
});

test('utf-8 split across chunks survives', async () => {
  const { request } = await import('node:http');
  const payload = Buffer.from(JSON.stringify(report({ text: 'Knopf überlappt' })));
  const cut = payload.indexOf(Buffer.from('ü')) + 1;
  const data = await new Promise((resolve, reject) => {
    const req = request(base + '/report', { method: 'POST', headers: { 'content-type': 'text/plain', origin: ALLOWED } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t)));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, cut));
    setTimeout(() => req.end(payload.subarray(cut)), 20);
  });
  assert.equal(data.ok, true);
  assert.ok(gh.state.issues['Tim-Conrad/shop'][0].title.includes('überlappt'));
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('serves a stored picture', async () => {
  writeFileSync(join(shotsDir, 'abc-1.png'), PNG);
  const res = await fetch(base + '/shots/abc-1.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test('picture paths outside the store give 404', async () => {
  for (const p of ['/shots/../x.png', '/shots/%2e%2e%2fx.png', '/shots/a.txt', '/shots/missing.png']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
  }
});

test('a report with a picture of 9 MB fails cleanly, never 500', async () => {
  const shot = 'data:image/png;base64,' + Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]).toString('base64');
  const res = await post(report({ shot }));
  assert.ok([400, 413].includes(res.status), String(res.status));
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.ok(j.help);
});

test('a report with a picture of 1 MB goes through', async () => {
  const shot = 'data:image/png;base64,' + Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]).toString('base64');
  const res = await post(report({ shot }));
  assert.equal(res.status, 200);
});
