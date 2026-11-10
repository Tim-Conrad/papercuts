// A small GitHub REST client. The token goes only into the Authorization header.

export class GithubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function githubClient({ credential, apiBase = 'https://api.github.com', fetchImpl = fetch }) {
  let cached;
  async function call(method, path, body) {
    cached ??= credential.token();
    let token;
    try {
      token = await cached;
    } catch (e) {
      cached = undefined;
      throw new GithubError(0, e.message);
    }
    let res;
    try {
      res = await fetchImpl(apiBase + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'papercuts',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new GithubError(0, `no answer from GitHub (${e.name})`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const message = String(data?.message || res.statusText || 'error').split(token).join('[redacted]').slice(0, 200);
      const err = new GithubError(res.status, message);
      err.data = data;
      throw err;
    }
    return data;
  }
  const q = (params) => new URLSearchParams(params).toString();

  async function pages(repo, params, max) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const batch = await call('GET', `/repos/${repo}/issues?${q({ ...params, per_page: 100, page })}`);
      out.push(...batch.filter((i) => !i.pull_request));
      if (batch.length < 100) break;
    }
    return out.slice(0, max);
  }

  return {
    user: () => call('GET', '/user'),
    repo: (repo) => call('GET', `/repos/${repo}`),
    listOpen: (repo, label) => pages(repo, { state: 'open', labels: label }, 300),
    listRecent: (repo, label, n = 100) => pages(repo, { state: 'all', labels: label, sort: 'created', direction: 'desc' }, n),
    getIssue: (repo, n) => call('GET', `/repos/${repo}/issues/${n}`),
    comments: (repo, n) => call('GET', `/repos/${repo}/issues/${n}/comments?per_page=100`),
    createIssue: (repo, issue) => call('POST', `/repos/${repo}/issues`, issue),
    comment: (repo, n, body) => call('POST', `/repos/${repo}/issues/${n}/comments`, { body }),
    close: async (repo, n, comment) => {
      if (comment) await call('POST', `/repos/${repo}/issues/${n}/comments`, { body: comment });
      return call('PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed', state_reason: 'completed' });
    },
    async ensureLabels(repo, labels) {
      for (const name of labels) {
        try {
          await call('POST', `/repos/${repo}/labels`, { name, color: name === 'papercut' ? 'd93f0b' : 'ededed' });
        } catch (e) {
          if (!(e.status === 422 && e.data?.errors?.some((x) => x.code === 'already_exists'))) throw e;
        }
      }
    },
  };
}
