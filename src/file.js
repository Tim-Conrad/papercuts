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

// The picture goes to GitHub with the user token. If GitHub refuses it, it stays on the relay.
// A lost picture never stops the report.
async function savePicture(report, repo, { client, shots, publicUrl }) {
  try {
    return { shotUrl: (await client.uploadAsset(repo, report.shot, `papercut-${report.id}.png`)).url };
  } catch (e) {
    if (!(e instanceof GithubError)) throw e;
  }
  if (shots && publicUrl) {
    try {
      shots.save(report.id, report.shot);
      return { shotUrl: `${publicUrl.replace(/\/$/, '')}/shots/${report.id}.png` };
    } catch (e) {
      console.error('papercuts: picture not stored:', e.message);
    }
  }
  return { shotNote: 'The picture could not be saved.' };
}

export function targetRepo(report, target) {
  return target?.mode === 'central' ? target.centralRepo : report.repo;
}

export async function fileReport(report, { client, target, shots, publicUrl }) {
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
    const issue = buildIssue(report, target, report.shot ? await savePicture(report, repo, { client, shots, publicUrl }) : {});
    await client.ensureLabels(repo, issue.labels);
    return found(await client.createIssue(repo, issue), false);
  } catch (e) {
    if (!(e instanceof GithubError)) throw e;
    // Retry only what can heal by itself: no answer, a GitHub outage, a rate limit. A wrong repo or token never heals.
    const retry = e.status === 0 || e.status >= 500 || e.status === 429 || /rate limit/i.test(e.message);
    return { ok: false, retry, error: `github: ${e.status} ${e.message}`, help: HELP[e.status] || 'try again later, or run `papercuts doctor`' };
  }
}
