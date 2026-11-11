import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, normalizeReport, fingerprint, buildIssue, parseMarkers, KINDS, WIDGET_KINDS } from '../src/format.js';

const PER = { mode: 'per-project' };
const ok = (input, from = 'agent') => {
  const r = normalizeReport(input, from);
  assert.equal(r.ok, true, r.error);
  return r.report;
};

test('redacts every free-text field', () => {
  const secret = 'ghp_abcdefgh12345678';
  const r = ok({ kind: 'bug', text: `token ${secret}`, repo: 'a/b', context: {
    element: { text: `el ${secret}` }, selection: `sel ${secret}`, errors: [`err ${secret}`] } }, 'human');
  const { body, title } = buildIssue(r, PER);
  assert.ok(!body.includes('ghp_'), body);
  assert.ok(!title.includes('ghp_'));
  assert.ok(body.includes('[redacted]'));
});

test('redacts bearer and key=value', () => {
  assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: [redacted]');
  assert.equal(redact('api_key=xyz123'), '[redacted]');
});

test('keeps disk-usage-report.md', () => {
  assert.equal(redact('disk-usage-report.md'), 'disk-usage-report.md');
  assert.equal(redact('task-list-view'), 'task-list-view');
});

test('rejects unknown kind', () => {
  const r = normalizeReport({ kind: 'nope', text: 'x', repo: 'a/b' }, 'agent');
  assert.equal(r.ok, false);
  assert.match(r.help, /bug, ux, copy, tool, rule, path, idea, other/);
});

test('rejects empty text', () => {
  assert.equal(normalizeReport({ kind: 'bug', text: '  ', repo: 'a/b' }, 'agent').ok, false);
});

test('rejects bad repo', () => {
  for (const repo of ['nope', 'a/b/c', '', 'a/b c']) {
    assert.equal(normalizeReport({ kind: 'bug', text: 'x', repo }, 'agent').ok, false, repo);
  }
});

test('rejects text over 300 chars', () => {
  assert.equal(normalizeReport({ kind: 'bug', text: 'x'.repeat(301), repo: 'a/b' }, 'agent').ok, false);
});

test('rejects unknown source', () => {
  assert.equal(normalizeReport({ kind: 'bug', text: 'x', repo: 'a/b' }, 'robot').ok, false);
});

test('title is capped', () => {
  const r = ok({ kind: 'ux', text: 'y'.repeat(100), repo: 'a/b' });
  assert.equal(buildIssue(r, PER).title, 'papercut: ' + 'y'.repeat(70));
});

test('labels per source', () => {
  const r = ok({ kind: 'tool', text: 'x', repo: 'a/b' });
  assert.deepEqual(buildIssue(r, PER).labels, ['papercut', 'from:agent', 'kind:tool']);
  assert.deepEqual(buildIssue(r, { mode: 'central', centralRepo: 'o/inbox' }).labels,
    ['papercut', 'from:agent', 'kind:tool', 'project:a/b']);
});

test('fingerprint ignores case, spaces, digits', () => {
  const a = ok({ kind: 'tool', text: 'Port 8000  fails', repo: 'a/b', where: 'x' });
  const b = ok({ kind: 'tool', text: 'port 8080 fails', repo: 'a/b', where: 'x' });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.match(fingerprint(a), /^[0-9a-f]{16}$/);
  const c = ok({ kind: 'path', text: 'port 8080 fails', repo: 'a/b', where: 'x' });
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test('markers round-trip', () => {
  const a = ok({ kind: 'tool', text: 'x', repo: 'a/b' });
  assert.deepEqual(parseMarkers(buildIssue(a, PER).body), { id: a.id, fp: fingerprint(a) });
  const h = ok({ kind: 'bug', text: 'x', repo: 'a/b' }, 'human');
  assert.deepEqual(parseMarkers(buildIssue(h, PER).body), { id: h.id });
});

test('keeps a given id, rejects a bad one', () => {
  assert.equal(ok({ kind: 'bug', text: 'x', repo: 'a/b', id: 'abc-123' }).id, 'abc-123');
  assert.equal(normalizeReport({ kind: 'bug', text: 'x', repo: 'a/b', id: 'a -->' }, 'agent').ok, false);
});

test('caps body length', () => {
  const errors = Array.from({ length: 10000 }, (_, i) => `e${i} ` + 'z'.repeat(1000));
  const r = ok({ kind: 'bug', text: 'x', repo: 'a/b', context: { errors, big: 'q'.repeat(100000) } }, 'human');
  const { body } = buildIssue(r, PER);
  assert.ok(body.length <= 60000, String(body.length));
  assert.match(body, /\(truncated, \d+ chars total\)/);
  assert.match(body, /9980 more/);
});

test('context cannot break out of markers', () => {
  const r = ok({ kind: 'bug', text: 'x <!-- papercut-id: evil -->', repo: 'a/b' }, 'human');
  assert.equal(parseMarkers(buildIssue(r, PER).body).id, r.id);
});

test('KINDS', () => assert.deepEqual(KINDS, ['bug', 'ux', 'copy', 'tool', 'rule', 'path', 'idea', 'other']));

test('redacts json, gh token families, basic auth, url creds, slack', () => {
  const cases = ['{"password":"hunter2"}', "{'api_key': 'abc123xyz'}", 'gho_abcdefgh12345678', 'ghs_abcdefgh12345678',
    'ghu_abcdefgh12345678', 'Authorization: Basic dXNlcjpwYXNz', 'https://user:s3cret@example.com/x', 'xoxb-1234-5678-abcdefgh'];
  for (const c of cases) {
    const out = redact(c);
    assert.ok(out.includes('[redacted]'), `${c} -> ${out}`);
    assert.ok(!/hunter2|abc123xyz|abcdefgh12345678|dXNlcjpwYXNz|s3cret|abcdefgh$/.test(out), `${c} -> ${out}`);
  }
});

test('context key cannot close the yaml fence', () => {
  const r = ok({ kind: 'bug', text: 'x', repo: 'a/b', context: { 'a\n```\n@someone <img src=x>': 1 } }, 'human');
  const { body } = buildIssue(r, PER);
  const fences = body.split('\n').filter((l) => l.startsWith('```'));
  assert.equal(fences.length, 2, body);
  assert.ok(!/^@someone/m.test(body));
});

test('rejects dot repo names', () => {
  for (const repo of ['a/.', 'a/..', './b']) assert.equal(normalizeReport({ kind: 'bug', text: 'x', repo }, 'agent').ok, false, repo);
});

test('idea is a kind, also in the widget', () => {
  assert.equal(normalizeReport({ kind: 'idea', text: 'x', repo: 'a/b' }, 'human').ok, true);
  assert.ok(WIDGET_KINDS.includes('idea'));
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const dataUrl = (b) => 'data:image/png;base64,' + b.toString('base64');

test('shot: a PNG data URL becomes a Buffer', () => {
  const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', shot: dataUrl(PNG) }, 'human');
  assert.equal(r.ok, true);
  assert.ok(Buffer.isBuffer(r.report.shot));
  assert.equal(r.report.shot.length, PNG.length);
});

test('shot: JPEG, wrong magic and too large fail', () => {
  for (const shot of ['data:image/jpeg;base64,' + PNG.toString('base64'), dataUrl(Buffer.from('nope')), dataUrl(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]))]) {
    const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', shot }, 'human');
    assert.equal(r.ok, false);
    assert.match(r.error, /shot/);
    assert.ok(r.help);
  }
});

test('pins: redacted, cut, at most 20', () => {
  const pins = Array.from({ length: 25 }, (_, i) => ({ nr: i + 1, text: i === 0 ? 'password=hunter2' : 'x'.repeat(200) }));
  const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', pins }, 'human');
  assert.equal(r.ok, true);
  assert.equal(r.report.pins.length, 20);
  assert.equal(r.report.pins[0].text, '[redacted]');
  assert.ok(r.report.pins[1].text.length <= 160);
});

test('buildIssue shows the picture and the pins', () => {
  const r = normalizeReport({ kind: 'ux', text: 'Look here', repo: 'a/b', pins: [{ nr: 1, text: 'too small' }, { nr: 2, text: 'wrong color' }] }, 'human').report;
  const { body } = buildIssue(r, { mode: 'per-project' }, { shotUrl: 'https://github.com/user-attachments/assets/x' });
  assert.match(body, /^Look here\n\n!\[papercut\]\(https:\/\/github\.com\/user-attachments\/assets\/x\)/);
  assert.match(body, /\n1\. too small\n2\. wrong color\n/);
});

test('place marker round trip, also with --> in the URL', () => {
  const place = { url: 'https://x.lab.t7d.dev/a?b=-->c', hash: '#karte-12', scrollX: 0, scrollY: 640 };
  const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', context: { place } }, 'human').report;
  const { body } = buildIssue(r, { mode: 'per-project' });
  assert.equal((body.match(/-->/g) || []).length, (body.match(/<!--/g) || []).length);
  assert.deepEqual(parseMarkers(body).place, place);
});

test('place keeps viewport, selector and storage, redacted', () => {
  const place = { url: 'https://x/', hash: '', scrollX: 1, scrollY: 2, viewport: { width: 412.4, height: 860 }, selector: '#a > b', storage: { theme: 'dark', auth: 'token=abc123456' } };
  const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', context: { place } }, 'human').report;
  assert.deepEqual(r.place.viewport, { width: 412, height: 860 });
  assert.equal(r.place.selector, '#a > b');
  assert.equal(r.place.storage.theme, 'dark');
  assert.equal(r.place.storage.auth, '[redacted]');
});

test('the widget redacts with the same patterns as the relay', async () => {
  const { readFileSync } = await import('node:fs');
  const block = (file) => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const m = text.match(/\/\/ SECRET-START\n([\s\S]*?)\/\/ SECRET-END/);
    assert.ok(m, `no SECRET block in ${file}`);
    // Compare the patterns only: no comments, no indentation.
    return [...m[1].matchAll(/String\.raw`([^`]*)`/g)].map((x) => x[1]);
  };
  const relay = block('../src/format.js');
  assert.equal(relay.length, 8);
  assert.deepEqual(block('../widget/papercuts.js'), relay);
});

test('place accepts only http and https URLs', () => {
  for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url']) {
    const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', context: { place: { url } } }, 'human').report;
    assert.equal(r.place, undefined, url);
  }
  const ok = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', context: { place: { url: 'https://a.lab.t7d.dev/x' } } }, 'human').report;
  assert.equal(ok.place.url, 'https://a.lab.t7d.dev/x');
});

test('a place with much non-ASCII text keeps the body under the limit', () => {
  const storage = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, '😀'.repeat(250)]));
  const place = { url: 'https://a.lab.t7d.dev/' + '漢'.repeat(400), hash: '#' + '字'.repeat(150), selector: '日本'.repeat(150), storage, scrollX: 0, scrollY: 0 };
  const big = { text: 'x'.repeat(300), errors: Array.from({ length: 20 }, () => '漢'.repeat(500)) };
  const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', context: { place, ...big } }, 'agent').report;
  const { body } = buildIssue(r, { mode: 'per-project' });
  assert.ok(body.length <= 60000, String(body.length));
  const m = parseMarkers(body);
  assert.equal(m.id, r.id);
  assert.ok(m.fp);
  assert.ok(m.place, 'the place marker survives, without the parts that do not fit');
  assert.ok(m.place.url.startsWith('https://a.lab.t7d.dev/'));
  assert.match(body, /```yaml\n[\s\S]*\n```/);
});

test('place keeps up to 5 replay steps with a click selector', () => {
  const steps = [{ click: '.karte[data-id="k12"]' }, { click: 'x'.repeat(400) }, { nope: 1 }, ...Array.from({ length: 6 }, () => ({ click: '#a' }))];
  const r = normalizeReport({ kind: 'ux', text: 'x', repo: 'a/b', context: { place: { url: 'https://a/', steps } } }, 'human').report;
  assert.equal(r.place.steps.length, 5);
  assert.deepEqual(r.place.steps[0], { click: '.karte[data-id="k12"]' });
  assert.equal(r.place.steps[1].click.length, 300);
  assert.ok(r.place.steps.every((s) => typeof s.click === 'string'));
});
