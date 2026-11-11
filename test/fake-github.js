// An in-memory GitHub REST API for tests: issues, comments, labels, user.
import http from 'node:http';

export async function fakeGithub({ token = 'test-token-123' } = {}) {
  const state = { issues: {}, labels: {}, requests: [], fail: null, next: 1, lag: false, hidden: new Set() };
  const repoOf = (owner, name) => {
    const key = `${owner}/${name}`;
    state.issues[key] ??= [];
    state.labels[key] ??= new Set();
    return key;
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization });
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (state.fail) return send(state.fail, { message: `Bad credentials ${token}` });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
    if (url.pathname === '/user') return send(200, { login: 'tester' });
    let m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return send(404, { message: 'Not Found' });
    const key = repoOf(m[1], m[2]);
    const rest = m[3] || '';
    const list = state.issues[key];
    if (rest === '' && req.method === 'GET') return send(200, { full_name: key, permissions: { push: true } });
    if (rest === '/labels' && req.method === 'POST') {
      if (state.labels[key].has(body.name)) return send(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
      state.labels[key].add(body.name); return send(201, { name: body.name });
    }
    if (rest === '/issues' && req.method === 'GET') {
      const st = url.searchParams.get('state') || 'open';
      const label = url.searchParams.get('labels');
      const per = Number(url.searchParams.get('per_page') || 30);
      const page = Number(url.searchParams.get('page') || 1);
      // lag: like GitHub, a new issue is missing from lists for a few seconds, but a direct GET finds it.
      let items = list.filter((i) => !state.hidden.has(i.number) && (st === 'all' || i.state === st) && (!label || label.split(',').every((want) => i.labels.some((l) => l.name === want))));
      items = [...items].sort((a, b) => b.number - a.number);
      return send(200, items.slice((page - 1) * per, page * per));
    }
    if (rest === '/issues' && req.method === 'POST') {
      for (const l of body.labels || []) if (!state.labels[key].has(l)) return send(422, { message: `label ${l} missing` });
      const n = state.next++;
      const issue = { number: n, title: body.title, body: body.body, state: 'open', labels: (body.labels || []).map((name) => ({ name })),
        html_url: `https://github.com/${key}/issues/${n}`, comments: 0, commentList: [], created_at: new Date().toISOString() };
      if (state.lag) state.hidden.add(n);
      list.push(issue); return send(201, issue);
    }
    m = rest.match(/^\/issues\/(\d+)(\/comments)?$/);
    if (m) {
      const issue = list.find((i) => i.number === Number(m[1]));
      if (!issue) return send(404, { message: 'Not Found' });
      if (m[2] && req.method === 'POST') { issue.commentList.push(body.body); issue.comments++; return send(201, { body: body.body }); }
      if (m[2] && req.method === 'GET') return send(200, issue.commentList.map((b) => ({ body: b })));
      if (req.method === 'PATCH') { Object.assign(issue, body); return send(200, issue); }
      if (req.method === 'GET') return send(200, issue);
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  return { state, apiBase, token, close: () => new Promise((r) => server.close(r)) };
}
