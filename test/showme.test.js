// SHOWME.md is the visual guide, and t7d.dev/tools/papercuts/ shows it from the latest release.
// These tests keep it in line with the README, the code and what the site can draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { KINDS } from '../src/format.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const showme = read('SHOWME.md');
const readme = read('README.md');
const DIR = 'docs/showme/';
const svgs = readdirSync(new URL(DIR, root)).filter((f) => f.endsWith('.svg'));

// The anchor that GitHub and the site give a heading.
const slug = (heading) => heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
const anchors = (text) => new Set([...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) => slug(m[1])));

test('every picture of SHOWME.md exists, and every picture is used', () => {
  const used = [...showme.matchAll(/!\[[^\]]*\]\(([^\s)]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const path of used) assert.ok(path.startsWith(DIR) && svgs.includes(path.slice(DIR.length)), `missing picture: ${path}`);
  for (const f of svgs) assert.ok(used.includes(DIR + f), `${DIR}${f} is not in SHOWME.md: use it or delete it`);
});

test('every picture has an alt text and a caption', () => {
  for (const m of showme.matchAll(/!\[([^\]]*)\]\(([^\s)]+)( "[^"]+")?\)/g)) {
    assert.ok(m[1].length > 20, `alt text of ${m[2]}`);
    assert.ok(m[3], `caption of ${m[2]}: ![alt](path "caption")`);
  }
});

test('links into the README point to headings that exist', () => {
  const have = anchors(readme);
  const links = [...showme.matchAll(/\]\(README\.md#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0);
  for (const a of links) assert.ok(have.has(a), `README.md has no heading for #${a}`);
});

test('SHOWME.md names every kind, and no version number', () => {
  for (const k of KINDS) assert.ok(showme.includes('`' + k + '`'), `kind ${k} is missing in SHOWME.md`);
  assert.equal(/\bv?\d+\.\d+\.\d+\b/.test(showme.replace(/127\.0\.0\.1/g, '')), false, 'the site shows the version of the release');
});

// The site puts each picture into its page as inline SVG under a strict Content-Security-Policy.
// It draws these classes with its own styles and refuses everything else.
const CLASSES = ['t-s', 't-h', 't-m', 't-inv', 'ln', 'ln-s', 'bx', 'bx-s', 'bx-i', 'bx-d', 'arr', 'paper'];
const ELEMENTS = ['svg', 'title', 'desc', 'style', 'g', 'rect', 'line', 'polyline', 'polygon', 'path', 'circle', 'text', 'tspan'];

test('every picture uses only what the site can draw', () => {
  const style = (svg) => (svg.match(/<style[^>]*>[\s\S]*?<\/style>/) || [''])[0];
  const first = style(read(DIR + svgs[0]));
  for (const f of svgs) {
    const svg = read(DIR + f);
    assert.match(svg, /<title[ >]/, `${f}: a <title>`);
    assert.match(svg, /<desc[ >]/, `${f}: a <desc>`);
    assert.match(svg, /viewBox="0 0 680 \d+"/, `${f}: 680 wide, like the other pictures`);
    assert.equal(style(svg), first, `${f}: the same <style> block as ${svgs[0]}`);
    for (const m of svg.matchAll(/<([a-zA-Z][\w:-]*)/g)) assert.ok(ELEMENTS.includes(m[1]), `${f}: <${m[1]}> is not allowed`);
    for (const m of svg.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) assert.ok(CLASSES.includes(c), `${f}: class ${c} is not a class of the site`);
    }
    assert.equal(/\sstyle=|\son\w+=|href=|url\(|<script|fill="|stroke="/.test(svg), false, `${f}: no style attribute, colour, link or script`);
  }
});
