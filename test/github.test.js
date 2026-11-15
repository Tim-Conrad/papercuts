import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubClient } from '../src/github.js';

// A token without "Pull requests: read" (the lab relay's GitHub App token): the issue list hides
// pull requests, and GET /issues/<n> of a pull request answers 403. The probe for fresh issues
// must step over it.
test('the probe for fresh issues skips pull requests that the token cannot read', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    seen.push(path);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path.startsWith('/repos/o/r/issues?') && new URL(url).searchParams.get('per_page') === '1') return json(200, [{ number: 2 }]);
    if (path === '/repos/o/r/issues/3') return json(403, { message: 'Resource not accessible by integration' });
    if (path === '/repos/o/r/issues/4') return json(200, { number: 4, state: 'open', labels: [{ name: 'papercut' }] });
    if (path === '/repos/o/r/issues/5') return json(404, { message: 'Not Found' });
    if (path.startsWith('/repos/o/r/issues?')) return json(200, []);
    return json(500, { message: `unexpected ${path}` });
  };
  const client = githubClient({ credential: { token: async () => 't' }, apiBase: 'https://gh.example', fetchImpl });
  const open = await client.listOpen('o/r', 'papercut');
  assert.deepEqual(open.map((i) => i.number), [4]);
  assert.ok(seen.includes('/repos/o/r/issues/3'));
});
