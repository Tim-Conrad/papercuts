// A small GitHub REST client. The token goes only into the Authorization header.

export class GithubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function githubClient({ credential, apiBase = 'https://api.github.com', uploadBase = 'https://uploads.github.com', fetchImpl = fetch }) {
  let cached;
  const repoIds = new Map();
  // A 401 means the token changed (gh auth refresh, a new PAT). Ask the source again, once.
  async function call(method, path, body, retried = false, { base = apiBase, raw, type } = {}) {
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
      res = await fetchImpl(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'papercuts',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(raw ? { 'content-type': type } : {}),
        },
        body: raw ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new GithubError(0, `no answer from GitHub (${e.name})`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.status === 401 && !retried) {
      cached = undefined;
      return call(method, path, body, true, { base, raw, type });
    }
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

  // GitHub lists a new issue only after about 3 seconds, but a direct GET finds it at once.
  // Fetch the numbers above the newest listed issue or pull request until GitHub answers 404.
  async function fresh(repo, params) {
    const top = await call('GET', `/repos/${repo}/issues?${q({ state: 'all', sort: 'created', direction: 'desc', per_page: 1 })}`);
    const want = params.labels ? params.labels.split(',') : [];
    const out = [];
    for (let n = (top[0]?.number ?? 0) + 1, probes = 0; probes < 20; n++, probes++) {
      let issue;
      try {
        issue = await call('GET', `/repos/${repo}/issues/${n}`);
      } catch (e) {
        if (e.status === 404) break;
        if (e.status === 410) continue; // a deleted issue keeps its number
        throw e;
      }
      const names = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
      if (issue.pull_request || !want.every((w) => names.includes(w))) continue;
      if (params.state !== 'all' && issue.state !== params.state) continue;
      out.unshift(issue);
    }
    return out;
  }

  async function listed(repo, params, max) {
    const recent = await fresh(repo, params);
    const seen = new Set(recent.map((i) => i.number));
    return [...recent, ...(await pages(repo, params, max)).filter((i) => !seen.has(i.number))].slice(0, max);
  }

  return {
    user: () => call('GET', '/user'),
    repo: (repo) => call('GET', `/repos/${repo}`),
    listOpen: (repo, label) => listed(repo, { state: 'open', labels: label }, 300),
    listRecent: (repo, label, n = 100) => listed(repo, { state: 'all', labels: label, sort: 'created', direction: 'desc' }, n),
    // Not documented by GitHub. gh issue create --attach uses it, and it answers {url}. It needs a user token:
    // installation tokens of a GitHub App get a 404 (cli/cli#14309).
    async uploadAsset(repo, buffer, name) {
      if (!repoIds.has(repo)) repoIds.set(repo, (await call('GET', `/repos/${repo}`)).id);
      const q2 = new URLSearchParams({ content_type: 'image/png', name, repository_id: String(repoIds.get(repo)) });
      const out = await call('POST', `/user-attachments/assets?${q2}`, undefined, false, { base: uploadBase, raw: buffer, type: 'image/png' });
      if (!out?.url) throw new GithubError(0, 'the upload gave no url');
      return { url: out.url };
    },
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
