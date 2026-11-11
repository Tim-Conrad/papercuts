import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toon } from '../src/toon.js';

test('table of objects', () => {
  assert.equal(toon({ papercuts: [{ id: 12, kind: 'tool', title: 'a, b' }] }),
    'papercuts[1]{id,kind,title}:\n  12,tool,"a, b"');
});
test('scalar', () => assert.equal(toon({ count: '3 of 9 open' }), 'count: 3 of 9 open'));
test('list of strings', () => assert.equal(toon({ help: ['Run `x`'] }), 'help[1]:\n  Run `x`'));
test('empty array', () => assert.equal(toon({ papercuts: [] }), 'papercuts[0]:'));
test('nested object', () => assert.equal(toon({ a: { b: 1, c: 'x y' } }), 'a:\n  b: 1\n  c: x y'));
test('scalar quotes only empty, newline, edge space', () => {
  assert.equal(toon({ a: '', b: 'x: y', c: 'l1\nl2', d: ' pad' }), 'a: ""\nb: x: y\nc: "l1\\nl2"\nd: " pad"');
});
test('missing field in a row is empty', () => {
  assert.equal(toon({ t: [{ a: 1, b: 2 }, { a: 3 }] }), 't[2]{a,b}:\n  1,2\n  3,""');
});
test('null and booleans', () => assert.equal(toon({ a: null, b: true }), 'a: null\nb: true'));
