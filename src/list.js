// The open papercuts of a repo, with +1 count, replies and place. The CLI home view and the relay /list use it.
import { parseMarkers, shorten } from './format.js';

const PLUS = /^\+1\b/;

export async function openPapercuts(client, repo, label = 'papercut') {
  const issues = await client.listOpen(repo, label);
  return Promise.all(issues.map(async (i) => {
    const names = i.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const comments = i.comments > 0 ? await client.comments(repo, i.number) : [];
    const replies = comments.filter((c) => !PLUS.test(c.body || ''));
    return {
      issue: i.number,
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
