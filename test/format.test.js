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
