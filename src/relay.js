// The relay: it serves the widget and files reports. It holds the GitHub credential, the browser never does.
// Reports come as simple requests (POST, text/plain, no custom headers), so the browser sends no CORS preflight
// and Authelia can stay in front of every route.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeReport } from './format.js';
import { fileReport } from './file.js';
import { originAllowed, repoAllowed, VERSION } from './config.js';

const WIDGET = fileURLToPath(new URL('../widget/papercuts.js', import.meta.url));
const MAX_BODY = 256 * 1024;

export function createRelay(config, { client }) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, config.origins);
    const send = (code, data, type = 'application/json') => {
      const headers = { 'content-type': type, 'cache-control': 'no-cache', vary: 'Origin', 'x-content-type-options': 'nosniff' };
      if (allowed) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' });
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
      if (url.pathname !== '/report') return send(404, { ok: false, error: 'not found', help: 'the relay has /papercuts.js, /status and /report' });
      if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST', help: 'POST a JSON text body to /report' });
      if (!allowed) return send(403, { ok: false, error: 'origin not allowed', help: 'add the site origin to PAPERCUTS_ORIGINS' });
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (type !== 'text/plain') return send(415, { ok: false, error: 'content type must be text/plain', help: 'send JSON text as text/plain, so that no preflight happens' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return send(413, { ok: false, error: 'report too large', help: 'send a shorter report' });
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { return send(400, { ok: false, error: 'body is not JSON', help: 'send {"from":"human","report":{...}}' }); }
      const norm = normalizeReport(payload?.report, payload?.from ?? 'human');
      if (!norm.ok) return send(400, norm);
      if (!repoAllowed(norm.report.repo, config.repos)) {
        return send(403, { ok: false, error: `repo ${norm.report.repo} not allowed`, help: 'add the repo to PAPERCUTS_REPOS' });
      }
      const result = await fileReport(norm.report, { client, target: config.target });
      return send(result.ok ? 200 : 502, result);
    } catch (e) {
      console.error('papercuts relay:', e.message);
      if (!res.headersSent) send(500, { ok: false, error: 'relay error', help: 'read the relay log' });
    }
  });
}
