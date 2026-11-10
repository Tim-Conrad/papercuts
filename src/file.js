// File one report: return the old issue for a known id, add +1 for a known agent fingerprint, else open an issue.
import { buildIssue, fingerprint, parseMarkers } from './format.js';
import { GithubError } from './github.js';

const HELP = {
  0: 'check the network and the credential: run `papercuts doctor`',
  401: 'the token is not valid: run `papercuts doctor`',
  403: 'the token has no access to issues in this repo: run `papercuts doctor`',
  404: 'the repo does not exist, or the token cannot see it: run `papercuts doctor`',
};

function contextLines(report) {
  const where = report.where ? ` at \`${report.where}\`` : '';
  return `+1${where} (${new Date().toISOString()})\n\n<!-- papercut-id: ${report.id} -->\n`;
}

export function targetRepo(report, target) {
  return target?.mode === 'central' ? target.centralRepo : report.repo;
}

export async function fileReport(report, { client, target }) {
  const repo = targetRepo(report, target);
  const found = (issue, deduped) => ({ ok: true, issue: issue.number, url: issue.html_url, deduped, repo });
  try {
    const recent = await client.listRecent(repo, 'papercut', 100);
    const same = recent.find((i) => parseMarkers(i.body).id === report.id);
    if (same) return found(same, false);
    if (report.from === 'agent') {
      const fp = fingerprint(report);
      const open = await client.listOpen(repo, 'papercut');
      const match = open.find((i) => parseMarkers(i.body).fp === fp);
      if (match) {
        await client.comment(repo, match.number, contextLines(report));
        return found(match, true);
      }
    }
    const issue = buildIssue(report, target);
    await client.ensureLabels(repo, issue.labels);
    return found(await client.createIssue(repo, issue), false);
  } catch (e) {
    if (!(e instanceof GithubError)) throw e;
    return { ok: false, error: `github: ${e.status} ${e.message}`, help: HELP[e.status] || 'try again later, or run `papercuts doctor`' };
  }
}
