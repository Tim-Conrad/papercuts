// The open papercuts of a repo, with +1 count, replies and place. The CLI home view and the relay /list use it.
import { parseMarkers, shorten } from './format.js';

const PLUS = /^\+1\b/;

export async function openPapercuts(client, repo, label = 'papercut') {
  return describe(client, repo, await client.listOpen(repo, label));
}

// The open papercuts and the ones closed in the last `closedDays` days, so that a reporter sees the fix.
export async function listPapercuts(client, repo, label = 'papercut', { closedDays = 14 } = {}) {
  const since = new Date(Date.now() - closedDays * 86400000).toISOString();
  const [open, closed] = await Promise.all([client.listOpen(repo, label), client.listClosedSince(repo, label, since)]);
  const recent = closed.filter((i) => i.closed_at && i.closed_at >= since);
  return describe(client, repo, [...open, ...recent]);
}

const FIX = /^Fixed: /;

function describe(client, repo, issues) {
  return Promise.all(issues.map(async (i) => {
    const names = i.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const comments = i.comments > 0 ? await client.comments(repo, i.number) : [];
    const replies = comments.filter((c) => !PLUS.test(c.body || ''));
    const fix = [...comments].reverse().find((c) => FIX.test(c.body || ''));
    return {
      issue: i.number,
      state: i.state === 'closed' ? 'closed' : 'open',
      ...(i.state === 'closed' ? { closedAt: i.closed_at, fix: fix ? shorten(fix.body.replace(FIX, '').trim(), 300) : '' } : {}),
      kind: (names.find((n) => n.startsWith('kind:')) || 'kind:other').slice(5),
      from: (names.find((n) => n.startsWith('from:')) || 'from:human').slice(5),
      title: String(i.title).replace(/^papercut: /, ''),
      url: i.html_url,
      created: i.created_at,
      where: (String(i.body).match(/^where: (.*)$/m) || [])[1] || '',
      place: parseMarkers(i.body).place,
      plus: comments.length - replies.length,
      replyCount: replies.length,
      replies: replies.slice(-3).map((c) => ({ at: c.created_at, text: shorten(String(c.body || '').trim(), 300) })),
    };
  }));
}
