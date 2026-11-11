// Browser check harness: fake GitHub, the relay behind a mode switch, and a test page on a second origin.
// Prints one JSON line with the URLs. Control: GET <control>/mode?m=ok|down|redirect, GET <control>/issues.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fakeGithub } from '../fake-github.js';
import { githubClient } from '../../src/github.js';
import { createRelay } from '../../src/relay.js';
import { loadConfig } from '../../src/config.js';

const gh = await fakeGithub();
// uploadBase: pictures go to the fake GitHub, never to uploads.github.com.
const client = githubClient({ credential: { token: async () => gh.token, describe: () => 't' }, apiBase: gh.apiBase, uploadBase: gh.apiBase });
const relay = createRelay(loadConfig({ PAPERCUTS_ORIGINS: 'http://127.0.0.1:*', PAPERCUTS_REPOS: 'Tim-Conrad/*', PAPERCUTS_LIST_CACHE_MS: '0', PAPERCUTS_CONFIG_CACHE_MS: '0' }), { client });
const handler = relay.listeners('request')[0];
let mode = 'ok';
const front = http.createServer((req, res) => {
  if (mode === 'down') return req.socket.destroy();
  // nolist: the relay refuses the list, as it does for an origin outside PAPERCUTS_ORIGINS.
  if (mode === 'nolist' && req.url.startsWith('/list')) {
    res.writeHead(403, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-credentials': 'true' });
    return res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
  }
  if (mode === 'redirect' && req.url.startsWith('/report')) {
    res.writeHead(302, { location: 'https://auth.example/login' });
    return res.end();
  }
  return handler(req, res);
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const relayPort = await listen(front);
const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8').replaceAll('RELAY', `http://127.0.0.1:${relayPort}`);
// A 120x80 PNG with two color bands, for the drawing sheet.
function testPng() {
  const w = 120, h = 80, rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set(y < h / 2 ? [40, 90, 200] : [240, 200, 60], 1 + x * 3);
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PIC = testPng();

// ?lang=de adds data-lang to the script tag.
const pagePort = await listen(http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PIC); }
  const q = u.searchParams;
  let html = q.get('lang') ? page.replace('data-repo=', `data-lang="${q.get('lang')}" data-repo=`) : page;
  // ?storage=all: every localStorage key except the ones in data-storage-skip.
  for (const k of ['shortcut', 'gesture', 'voice']) if (q.get(k)) html = html.replace('data-repo=', `data-${k}="${q.get(k)}" data-repo=`);
  if (q.get('storage') === 'all') html = html.replace('data-storage="theme"', 'data-storage="*" data-storage-skip="room-code"');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
}));
const controlPort = await listen(http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/mode') mode = url.searchParams.get('m');
  if (url.pathname === '/fail') gh.state.fail = Number(url.searchParams.get('code')) || null;
  // inject: an issue written straight into the fake GitHub, as an attacker with GitHub access could.
  if (url.pathname === '/inject') {
    const list = (gh.state.issues['Tim-Conrad/shop'] ??= []);
    const n = gh.state.next++;
    list.push({ number: n, title: 'papercut: injected', body: url.searchParams.get('body'), state: 'open', labels: [{ name: 'papercut' }, { name: 'kind:bug' }],
      html_url: `https://github.com/Tim-Conrad/shop/issues/${n}`, comments: 0, commentList: [], created_at: new Date().toISOString() });
  }
  // config: the .github/papercuts.json of the test repo (empty value removes it).
  if (url.pathname === '/config') {
    const v = url.searchParams.get('json');
    gh.state.files['Tim-Conrad/shop'] = v ? { '.github/papercuts.json': v } : {};
  }
  if (url.pathname === '/close') {
    const issue = (gh.state.issues['Tim-Conrad/shop'] || []).find((i) => i.number === Number(url.searchParams.get('n')));
    if (issue) { issue.commentList.push(`Fixed: ${url.searchParams.get('fix')}`); issue.comments++; issue.state = 'closed'; issue.closed_at = new Date().toISOString(); }
  }
  if (url.pathname === '/comment') {
    const issue = (gh.state.issues['Tim-Conrad/shop'] || []).find((i) => i.number === Number(url.searchParams.get('n')));
    if (issue) { issue.commentList.push(url.searchParams.get('text')); issue.comments++; }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ mode, issues: gh.state.issues['Tim-Conrad/shop'] || [], uploads: gh.state.uploads.map((x) => x.bytes.subarray(0, 8).toString('hex')) }));
}));
console.log(JSON.stringify({ page: `http://127.0.0.1:${pagePort}/`, control: `http://127.0.0.1:${controlPort}` }));
