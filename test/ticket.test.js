import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, normalizeFields } from '../src/ticket.js';

test('an empty config gives the defaults and no warnings', () => {
  const { config, warnings } = checkConfig({});
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.fields, []);
  assert.deepEqual(config.presets, []);
  assert.deepEqual(config.kinds, ['bug', 'ux', 'copy', 'idea', 'other']);
});

test('a full config is kept', () => {
  const { config, warnings } = checkConfig({
    kinds: ['ux', 'bug'],
    fields: [{ id: 'expected', label: 'What did you expect?', required: true }, { id: 'device', label: 'Device', options: ['phone', 'desktop'] }],
    presets: [{ kind: 'ux', text: 'Too small to tap' }],
    labels: ['area:web'], labelsByKind: { bug: ['bug'] }, assignees: ['Tim-Conrad'],
    context: { storage: ['theme'], skipStorage: ['room'] }, lang: 'de',
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.kinds, ['ux', 'bug']);
  assert.equal(config.fields[0].required, true);
  assert.deepEqual(config.fields[1].options, ['phone', 'desktop']);
  assert.deepEqual(config.labelsByKind, { bug: ['bug'] });
  assert.equal(config.lang, 'de');
});

test('bad parts are dropped with a warning each, never an error', () => {
  const { config, warnings } = checkConfig({
    kinds: ['ux', 'nope'],
    fields: [{ id: 'Bad Id', label: 'x' }, { id: 'ok', label: '' }, ...Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, label: 'L' }))],
    presets: [{ kind: 'nope', text: 'x' }, { kind: 'ux', text: '' }],
    labels: ['x'.repeat(60), 7], assignees: ['not a login!'], surprise: true,
  });
  assert.deepEqual(config.kinds, ['ux']);
  assert.ok(config.fields.length <= 8);
  assert.ok(!config.fields.some((f) => f.id === 'Bad Id'));
  assert.deepEqual(config.presets, []);
  assert.deepEqual(config.labels, []);
  assert.deepEqual(config.assignees, []);
  for (const w of ['kinds', 'Bad Id', 'presets', 'labels', 'assignees', 'surprise', 'at most 8']) {
    assert.ok(warnings.some((x) => x.includes(w)), `no warning about ${w}: ${warnings.join(' | ')}`);
  }
});

test('not an object gives the defaults and a warning', () => {
  const { config, warnings } = checkConfig('nope');
  assert.deepEqual(config.fields, []);
  assert.equal(warnings.length, 1);
});

const CFG = checkConfig({ fields: [{ id: 'expected', label: 'What did you expect?', required: true }, { id: 'device', label: 'Device', options: ['phone', 'desktop'] }] }).config;

test('fields: valid values pass, redacted and cut', () => {
  const r = normalizeFields({ expected: 'password=hunter2 and ' + 'x'.repeat(400), device: 'phone' }, CFG);
  assert.equal(r.ok, true);
  assert.ok(r.fields.expected.startsWith('[redacted]'));
  assert.ok(r.fields.expected.length <= 340);
  assert.equal(r.fields.device, 'phone');
});

test('fields: unknown, missing required and bad option give an error with help', () => {
  const unknown = normalizeFields({ expected: 'x', nope: 'y' }, CFG);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown field "nope"/);
  assert.match(unknown.help, /expected, device/);
  const missing = normalizeFields({ device: 'phone' }, CFG);
  assert.match(missing.error, /field "expected" is required/);
  const bad = normalizeFields({ expected: 'x', device: 'watch' }, CFG);
  assert.match(bad.error, /"watch" is not an option of "device"/);
  assert.match(bad.help, /phone, desktop/);
});

test('fields: a repo without fields accepts none', () => {
  const r = normalizeFields({ any: 'x' }, checkConfig({}).config);
  assert.equal(r.ok, false);
  assert.match(r.help, /no fields/);
  assert.equal(normalizeFields(undefined, checkConfig({}).config).ok, true);
});
