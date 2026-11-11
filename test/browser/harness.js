// Browser check harness: fake GitHub, the relay behind a mode switch, and a test page on a second origin.
// Prints one JSON line with the URLs. Control: GET <control>/mode?m=ok|down|redirect, GET <control>/issues.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fakeGithub } from '../fake-github.js';
import { githubClient } from '../../src/github.js';
import { createRelay } from '../../src/relay.js';
import { loadConfig } from '../../src/config.js';

const gh = await fakeGithub();
const client = githubClient({ credential: { token: async () => gh.token, describe: () => 't' }, apiBase: gh.apiBase });
const relay = createRelay(loadConfig({ PAPERCUTS_ORIGINS: 'http://127.0.0.1:*', PAPERCUTS_REPOS: 'Tim-Conrad/*' }), { client });
const handler = relay.listeners('request')[0];
let mode = 'ok';
const front = http.createServer((req, res) => {
  if (mode === 'down') return req.socket.destroy();
  if (mode === 'redirect' && req.url.startsWith('/report')) {
    res.writeHead(302, { location: 'https://auth.example/login' });
    return res.end();
  }
  return handler(req, res);
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const relayPort = await listen(front);
const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8').replaceAll('RELAY', `http://127.0.0.1:${relayPort}`);
// ?lang=de adds data-lang to the script tag.
const pagePort = await listen(http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const html = q.get('lang') ? page.replace('data-repo=', `data-lang="${q.get('lang')}" data-repo=`) : page;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
}));
const controlPort = await listen(http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/mode') mode = url.searchParams.get('m');
  if (url.pathname === '/fail') gh.state.fail = Number(url.searchParams.get('code')) || null;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ mode, issues: gh.state.issues['Tim-Conrad/shop'] || [] }));
}));
console.log(JSON.stringify({ page: `http://127.0.0.1:${pagePort}/`, control: `http://127.0.0.1:${controlPort}` }));
