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
  assert.equal(s.version, '0.2.2');
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

const list = (repo, origin = ALLOWED) => fetch(`${base}/list?repo=${encodeURIComponent(repo)}`, { headers: origin ? { origin } : {} });

test('list: open papercuts with replies and place', async () => {
  const place = { url: 'https://shop.lab.t7d.dev/', hash: '#a', scrollX: 0, scrollY: 10 };
  const one = await (await post(report({ text: 'first', context: { place } }))).json();
  await post(report({ text: 'second' }));
  const issue = gh.state.issues['Tim-Conrad/shop'].find((i) => i.number === one.issue);
  issue.commentList.push('+1 at x', 'Fixed in abc1234, please check');
  issue.comments = 2;
  const res = await list('Tim-Conrad/shop');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.items.length, 2);
  const first = j.items.find((i) => i.issue === one.issue);
  assert.equal(first.title, 'first');
  assert.equal(first.kind, 'bug');
  assert.equal(first.from, 'human');
  assert.equal(first.replyCount, 1);
  assert.equal(first.plus, 1);
  assert.equal(first.replies[0].text, 'Fixed in abc1234, please check');
  assert.deepEqual(first.place, place);
});

test('list: foreign origin gets 403 and no items', async () => {
  await post(report());
  const res = await list('Tim-Conrad/shop', 'https://evil.example');
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.items, undefined);
});

test('list: without Origin (the CLI) is allowed', async () => {
  await post(report());
  const res = await list('Tim-Conrad/shop', null);
  assert.equal(res.status, 200);
});

test('list: repo outside the allow list gets 403', async () => {
  const res = await list('evil/repo');
  assert.equal(res.status, 403);
  assert.equal(gh.state.requests.length, 0);
});

test('list: a second call within 30 s makes no GitHub request', async () => {
  await post(report());
  await list('Tim-Conrad/shop');
  const n = gh.state.requests.length;
  await list('Tim-Conrad/shop');
  assert.equal(gh.state.requests.length, n);
});

test('list: a new report clears the cache of its repo', async () => {
  await post(report({ text: 'one' }));
  assert.equal((await (await list('Tim-Conrad/shop')).json()).items.length, 1);
  await post(report({ text: 'two' }));
  assert.equal((await (await list('Tim-Conrad/shop')).json()).items.length, 2);
});

test('list: also papercuts closed in the last 14 days, with the fix note', async () => {
  const open = await (await post(report({ text: 'still open' }))).json();
  const fixed = await (await post(report({ text: 'fixed lately' }))).json();
  const old = await (await post(report({ text: 'fixed long ago' }))).json();
  const all = gh.state.issues['Tim-Conrad/shop'];
  const f = all.find((i) => i.number === fixed.issue);
  f.state = 'closed'; f.closed_at = new Date().toISOString(); f.commentList.push('Fixed: the button is larger since abc1234'); f.comments = 1;
  const o = all.find((i) => i.number === old.issue);
  o.state = 'closed'; o.closed_at = new Date(Date.now() - 30 * 86400000).toISOString();
  const j = await (await list('Tim-Conrad/shop')).json();
  const nums = j.items.map((i) => i.issue);
  assert.ok(nums.includes(open.issue));
  assert.ok(nums.includes(fixed.issue));
  assert.ok(!nums.includes(old.issue));
  const item = j.items.find((i) => i.issue === fixed.issue);
  assert.equal(item.state, 'closed');
  assert.equal(item.fix, 'the button is larger since abc1234');
  assert.equal(j.items.find((i) => i.issue === open.issue).state, 'open');
});

const CONFIG = {
  fields: [{ id: 'expected', label: 'What did you expect?', required: true }, { id: 'device', label: 'Device', options: ['phone', 'desktop'] }],
  presets: [{ kind: 'ux', text: 'Too small to tap' }],
  labels: ['area:web'], labelsByKind: { bug: ['bug'] }, assignees: ['Tim-Conrad'],
};
const withConfig = (cfg = CONFIG, repo = 'Tim-Conrad/shop') => { gh.state.files[repo] = { '.github/papercuts.json': typeof cfg === 'string' ? cfg : JSON.stringify(cfg) }; };

test('config: the relay serves the checked config of the repo', async () => {
  withConfig();
  const res = await fetch(`${base}/config?repo=Tim-Conrad/shop`, { headers: { origin: ALLOWED } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.found, true);
  assert.deepEqual(j.warnings, []);
  assert.equal(j.config.fields[0].id, 'expected');
  assert.equal(j.config.presets[0].text, 'Too small to tap');
});

test('config: no file gives the defaults, a broken file gives the defaults and warnings', async () => {
  let j = await (await fetch(`${base}/config?repo=Tim-Conrad/shop`, { headers: { origin: ALLOWED } })).json();
  assert.equal(j.found, false);
  assert.deepEqual(j.config.fields, []);
  withConfig('{ not json', 'Tim-Conrad/other');
  j = await (await fetch(`${base}/config?repo=Tim-Conrad/other`, { headers: { origin: ALLOWED } })).json();
  assert.equal(j.ok, true);
  assert.match(j.warnings[0], /not valid JSON/);
});

test('config: a foreign origin gets 403, a repo outside the list gets 403', async () => {
  assert.equal((await fetch(`${base}/config?repo=Tim-Conrad/shop`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/config?repo=evil/x`, { headers: { origin: ALLOWED } })).status, 403);
});

test('report: fields, labels and assignees of the config go into the issue', async () => {
  withConfig();
  const res = await post(report({ kind: 'bug', fields: { expected: 'The button opens the cart', device: 'phone' } }));
  assert.equal(res.status, 200, await res.clone().text());
  const issue = gh.state.issues['Tim-Conrad/shop'].at(-1);
  assert.match(issue.body, /\*\*What did you expect\?\*\* The button opens the cart/);
  assert.match(issue.body, /\*\*Device\*\* phone/);
  const names = issue.labels.map((l) => l.name);
  for (const l of ['papercut', 'area:web', 'bug']) assert.ok(names.includes(l), names.join(','));
  const create = gh.state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/issues'));
  assert.deepEqual(create.body.assignees, ['Tim-Conrad']);
});

test('report: a missing required field or an unknown field gives 400 with help', async () => {
  withConfig();
  let res = await post({ ...report({ fields: { device: 'phone' } }), from: 'agent' });
  assert.equal(res.status, 400);
  let j = await res.json();
  assert.match(j.error, /"expected" is required/);
  assert.equal(j.retry, false);
  res = await post(report({ fields: { expected: 'x', nope: 'y' } }));
  j = await res.json();
  assert.match(j.error, /unknown field "nope"/);
  assert.match(j.help, /expected, device/);
});

test('report: a person without the required field still files the report', async () => {
  withConfig();
  const res = await post(report({ text: 'just feedback' }));
  assert.equal(res.status, 200, await res.clone().text());
});
