// The relay: it serves the widget and files reports. It holds the GitHub credential, the browser never does.
// Reports come as simple requests (POST, text/plain, no custom headers), so the browser sends no CORS preflight
// and Authelia can stay in front of every route.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeReport } from './format.js';
import { fileReport } from './file.js';
import { shotStore } from './shots.js';
import { listPapercuts } from './list.js';
import { loadRepoConfig, normalizeFields } from './ticket.js';
import { originAllowed, repoAllowed, VERSION } from './config.js';

const WIDGET = fileURLToPath(new URL('../widget/papercuts.js', import.meta.url));
// 8 MB of PNG is about 10.7 MB as base64, plus the context.
const MAX_BODY = 12 * 1024 * 1024;

export function createRelay(config, { client }) {
  // Two tabs can flush the same queued report at once. The second waits for the first, so one id makes one issue.
  const inFlight = new Map();
  const shots = shotStore(config.shotsDir);
  // Each open page asks for the list. The cache (30 s by default) keeps a few tabs from using up the GitHub rate limit.
  const listCache = new Map();
  const listFor = (repo) => {
    const hit = listCache.get(repo);
    if (hit && Date.now() - hit.at < config.listCacheMs) return hit.items;
    const central = config.target.mode === 'central';
    const items = listPapercuts(client, central ? config.target.centralRepo : repo, central ? `papercut,project:${repo}` : 'papercut');
    listCache.set(repo, { at: Date.now(), items });
    items.catch(() => listCache.delete(repo));
    return items;
  };
  // The ticket config of each repo (.github/papercuts.json), 5 minutes per repo.
  const configCache = new Map();
  const repoConfig = (repo) => {
    const hit = configCache.get(repo);
    if (hit && Date.now() - hit.at < config.configCacheMs) return hit.value;
    const value = loadRepoConfig(client, repo);
    configCache.set(repo, { at: Date.now(), value });
    value.catch(() => configCache.delete(repo));
    return value;
  };
  const fileOnce = (report, repoCfg) => {
    if (!inFlight.has(report.id)) {
      inFlight.set(report.id, fileReport(report, { client, target: config.target, shots, publicUrl: config.publicUrl, config: repoCfg }).finally(() => inFlight.delete(report.id)));
    }
    return inFlight.get(report.id);
  };
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, config.origins);
    const send = (code, data, type = 'application/json', readable = allowed) => {
      const headers = { 'content-type': type, 'cache-control': 'no-cache', vary: 'Origin', 'x-content-type-options': 'nosniff' };
      if (readable && origin) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' });
      res.writeHead(code, headers);
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://relay');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, 'ok', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/papercuts.js') {
        return send(200, readFileSync(WIDGET, 'utf8'), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(200, { ok: true, version: VERSION, target: config.target.mode });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/shots/')) {
        const m = url.pathname.match(/^\/shots\/([A-Za-z0-9_-]{1,64})\.png$/);
        const png = m && shots.read(m[1]);
        if (!png) return send(404, { ok: false, error: 'no such picture', help: 'pictures are at /shots/<report id>.png' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(png);
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        if (origin && !allowed) return send(403, { ok: false, error: 'origin not allowed', help: 'add the site origin to PAPERCUTS_ORIGINS' }, 'application/json', true);
        const repo = url.searchParams.get('repo') || '';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !repoAllowed(repo, config.repos)) {
          return send(403, { ok: false, error: `repo ${repo} not allowed`, help: 'add the repo to PAPERCUTS_REPOS' });
        }
        try {
          const c = await repoConfig(repo);
          return send(200, { ok: true, repo, found: c.found, config: c.config, warnings: c.warnings });
        } catch (e) {
          return send(502, { ok: false, error: `github: ${e.status ?? 0} ${e.message}`, help: 'try again later' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/list') {
        // A browser sends Origin, and only allowed sites may read titles. The CLI on the proxy network sends none.
        if (origin && !allowed) return send(403, { ok: false, error: 'origin not allowed', help: 'add the site origin to PAPERCUTS_ORIGINS' }, 'application/json', true);
        const repo = url.searchParams.get('repo') || '';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !repoAllowed(repo, config.repos)) {
          return send(403, { ok: false, error: `repo ${repo} not allowed`, help: 'add the repo to PAPERCUTS_REPOS' });
        }
        try {
          return send(200, { ok: true, repo, items: await listFor(repo) });
        } catch (e) {
          return send(502, { ok: false, error: `github: ${e.status ?? 0} ${e.message}`, help: 'try again later' });
        }
      }
      if (url.pathname !== '/report') return send(404, { ok: false, error: 'not found', help: 'the relay has /papercuts.js, /status, /report, /list and /shots/<id>.png' });
      if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST', help: 'POST a JSON text body to /report' });
      // The page must be able to read this refusal, or it takes it for a network error and retries forever.
      if (!allowed) return send(403, { ok: false, retry: false, error: 'origin not allowed', help: 'add the site origin to PAPERCUTS_ORIGINS' }, 'application/json', true);
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (type !== 'text/plain') return send(415, { ok: false, error: 'content type must be text/plain', help: 'send JSON text as text/plain, so that no preflight happens' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(413, { ok: false, retry: false, error: 'report too large', help: 'send a shorter report' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(400, { ok: false, error: 'body is not JSON', help: 'send {"from":"human","report":{...}}' }); }
      const norm = normalizeReport(payload?.report, payload?.from ?? 'human');
      if (!norm.ok) return send(400, { ...norm, retry: false });
      if (!repoAllowed(norm.report.repo, config.repos)) {
        return send(403, { ok: false, retry: false, error: `repo ${norm.report.repo} not allowed`, help: 'add the repo to PAPERCUTS_REPOS' });
      }
      let repoCfg;
      try { repoCfg = (await repoConfig(norm.report.repo)).config; } catch (e) {
        return send(502, { ok: false, retry: true, error: `github: ${e.status ?? 0} ${e.message}`, help: 'the report waits and goes out later' });
      }
      const fields = normalizeFields(payload.report.fields, repoCfg);
      if (!fields.ok) return send(400, { ...fields, retry: false });
      norm.report.fields = fields.fields;
      const result = await fileOnce(norm.report, repoCfg);
      if (result.ok) listCache.delete(norm.report.repo);
      return send(result.ok ? 200 : result.retry ? 502 : 422, result);
    } catch (e) {
      console.error('papercuts relay:', e.message);
      if (!res.headersSent) send(500, { ok: false, error: 'relay error', help: 'read the relay log' });
    }
  });
}
