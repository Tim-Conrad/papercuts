// The one issue format for the widget, the JS API and the CLI.
// Validate and redact here, before anything leaves the machine. The relay runs the same code again.
import { createHash, randomUUID } from 'node:crypto';

export const KINDS = ['bug', 'ux', 'copy', 'tool', 'rule', 'path', 'idea', 'other'];
export const WIDGET_KINDS = ['bug', 'ux', 'copy', 'idea', 'other'];
export const SOURCES = ['human', 'agent'];

export const LIMITS = { text: 300, where: 120, field: 500, errors: 20, body: 60000, title: 70, shot: 8 * 1024 * 1024, pins: 20, pin: 120 };
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_PREFIX = 'data:image/png;base64,';

// Ported from pen-and-paper papercut.py (GEHEIM). sk- only at the start of a word:
// disk-usage-report.md and task-list-view are no keys.
// SECRET-START
const SECRET = new RegExp([
  String.raw`(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{8,}`,
  String.raw`gh[opsur]_[A-Za-z0-9]{8,}`,          // ghp_ (PAT), gho_ (gh auth token), ghs_, ghu_, ghr_
  String.raw`github_pat_\S+`,
  String.raw`xox[abprs]-[A-Za-z0-9-]{8,}`,        // Slack
  String.raw`(?:Bearer|Basic)\s+\S+`,
  String.raw`AKIA[0-9A-Z]{16}`,
  String.raw`(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)`,  // user:password in a URL
  // key=value and JSON "key": "value", as console.error(JSON) logs it
  String.raw`["']?(?:api[_-]?key|token|password|passwd|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)`,
].join('|'), 'gi');
// SECRET-END
const REPO = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function redact(text) {
  return String(text).replace(SECRET, '[redacted]');
}

// A user string must not open or close an HTML comment, or it could fake a marker.
function clean(text) {
  return redact(text).replace(/<!--/g, '<! --').replace(/-->/g, '-- >');
}

export function shorten(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated, ${text.length} chars total)`;
}

function fail(error, help) {
  return { ok: false, error, help };
}

// Redact and shorten every string in the context, at any depth.
function cleanContext(value, depth = 0) {
  if (depth > 6) return '[too deep]';
  if (typeof value === 'string') return shorten(clean(value), LIMITS.field);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => cleanContext(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) out[clean(k).slice(0, 80)] = cleanContext(v, depth + 1);
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

// Where the reporter was: the page can scroll back there. Kept exact (only redacted) for the marker.
function cleanPlace(p) {
  if (!p || typeof p !== 'object') return undefined;
  // "Go to place" and replay open this URL. Only http and https: a javascript: URL would run in the app.
  let proto;
  try { proto = new URL(String(p.url)).protocol; } catch { return undefined; }
  if (proto !== 'http:' && proto !== 'https:') return undefined;
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  const place = { url: redact(String(p.url ?? '')).slice(0, 500), hash: redact(String(p.hash ?? '')).slice(0, 200), scrollX: num(p.scrollX), scrollY: num(p.scrollY) };
  if (p.viewport && typeof p.viewport === 'object') place.viewport = { width: num(p.viewport.width), height: num(p.viewport.height) };
  if (p.selector) place.selector = String(p.selector).slice(0, 300);
  if (p.storage && typeof p.storage === 'object' && !Array.isArray(p.storage)) {
    place.storage = Object.fromEntries(Object.entries(p.storage).slice(0, 20).map(([k, v]) => [String(k).slice(0, 80), redact(String(v ?? '')).slice(0, 500)]));
  }
  return place;
}

export function normalizeReport(input, from) {
  if (!SOURCES.includes(from)) return fail(`unknown source "${from}"`, 'use one of: human, agent');
  const src = input && typeof input === 'object' ? input : {};
  const kind = String(src.kind ?? '').trim();
  if (!KINDS.includes(kind)) return fail(`unknown kind "${kind}"`, `use one of: ${KINDS.join(', ')}`);
  const text = String(src.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fail('text is empty', 'write one sentence about the papercut');
  if (text.length > LIMITS.text) return fail(`text has ${text.length} chars, the limit is ${LIMITS.text}`, 'write one shorter sentence');
  const repo = String(src.repo ?? '').trim();
  if (!REPO.test(repo)) return fail(`repo "${repo}" is not owner/name`, 'give the repo as owner/name, for example Tim-Conrad/papercuts');
  const id = src.id == null ? randomUUID() : String(src.id);
  if (!ID.test(id)) return fail('id must be 1-64 chars of A-Z, a-z, 0-9, _ or -', 'leave out the id, papercuts makes one');
  const where = shorten(clean(String(src.where ?? '').replace(/\s+/g, ' ').trim()), LIMITS.where);
  const raw = src.context && typeof src.context === 'object' && !Array.isArray(src.context) ? { ...src.context } : {};
  if (Array.isArray(raw.errors) && raw.errors.length > LIMITS.errors) {
    raw.errors = [`(${raw.errors.length - LIMITS.errors} more)`, ...raw.errors.slice(-LIMITS.errors)];
  }
  const context = cleanContext(raw);
  const place = cleanPlace(raw.place);
  let shot;
  if (src.shot != null) {
    const bad = fail('shot is not a PNG of at most 8 MB', 'send the picture as data:image/png;base64,..., or leave it out');
    if (typeof src.shot !== 'string' || !src.shot.startsWith(PNG_PREFIX)) return bad;
    const b64 = src.shot.slice(PNG_PREFIX.length);
    if (b64.length > Math.ceil(LIMITS.shot / 3) * 4 + 4) return bad;
    shot = Buffer.from(b64, 'base64');
    if (shot.length > LIMITS.shot || !shot.subarray(0, 8).equals(PNG_MAGIC)) return bad;
  }
  const pins = (Array.isArray(src.pins) ? src.pins : []).slice(0, LIMITS.pins).map((p, i) => ({
    nr: Number.isInteger(p?.nr) ? p.nr : i + 1,
    text: shorten(clean(String(p?.text ?? '').replace(/\s+/g, ' ').trim()), LIMITS.pin),
  }));
  return { ok: true, report: { id, from, kind, text: clean(text), where, repo, context, place, shot, pins } };
}

export function fingerprint(report) {
  const norm = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${report.kind}|${norm(report.where)}|${norm(report.text)}`).digest('hex').slice(0, 16);
}

export function labelsFor(report, target) {
  const labels = ['papercut', `from:${report.from}`, `kind:${report.kind}`];
  if (target?.mode === 'central') labels.push(`project:${report.repo}`);
  return labels;
}

function yamlValue(v) {
  if (typeof v === 'string' && /^[^:#\n"'{}\[\],&*!|>%@`-][^:#\n"{}\[\]]*$/.test(v) && v.trim() === v) return v;
  return JSON.stringify(v);
}

// A key from the page could hold a newline and close the code fence, so quote any unusual key.
const yamlKey = (k) => (/^[\w.-]+$/.test(k) ? k : JSON.stringify(k));

function yamlLines(obj, indent = '') {
  const lines = [];
  for (const [rawKey, v] of Object.entries(obj)) {
    const k = yamlKey(rawKey);
    if (v === undefined || v === '') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      lines.push(`${indent}${k}:`, ...yamlLines(v, indent + '  '));
    } else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) {
      lines.push(`${indent}${k}:`, ...v.map((x) => `${indent}  - ${JSON.stringify(x)}`));
    } else {
      lines.push(`${indent}${k}: ${yamlValue(v)}`);
    }
  }
  return lines;
}

// One non-ASCII character becomes up to 12 characters in the marker. Drop the large parts until it fits.
const PLACE_MARKER_MAX = 8000;
function placeMarkerFor(place) {
  if (!place) return undefined;
  const p = { ...place };
  for (const drop of [null, 'storage', 'selector', 'hash']) {
    if (drop) delete p[drop];
    const m = `<!-- papercut-place: ${encodeURIComponent(JSON.stringify(p))} -->`;
    if (m.length <= PLACE_MARKER_MAX) return m;
  }
  for (let n = p.url.length; n > 0; n = Math.floor(n / 2)) {
    const m = `<!-- papercut-place: ${encodeURIComponent(JSON.stringify({ ...p, url: p.url.slice(0, n) }))} -->`;
    if (m.length <= PLACE_MARKER_MAX) return m;
  }
  return undefined;
}

export function buildIssue(report, target, { shotUrl, shotNote } = {}) {
  const title = `papercut: ${report.text.slice(0, LIMITS.title)}`;
  const extra = [];
  if (shotUrl) extra.push(`![papercut](${shotUrl})`);
  else if (shotNote) extra.push(`_${shotNote}_`);
  if (report.pins?.length) extra.push(report.pins.map((p) => `${p.nr}. ${p.text || '(no text)'}`).join('\n'));
  const lead = [report.text, ...extra].join('\n\n');
  const head = { kind: report.kind, from: report.from, where: report.where, repo: report.repo };
  let meta = yamlLines({ ...head, context: report.context }).join('\n');
  const markers = [`<!-- papercut-id: ${report.id} -->`];
  if (report.from === 'agent') markers.push(`<!-- papercut-fp: ${fingerprint(report)} -->`);
  // encodeURIComponent turns < and > into %3C and %3E, so the value cannot close the comment.
  const placeMarker = placeMarkerFor(report.place);
  if (placeMarker) markers.push(placeMarker);
  const room = Math.max(0, LIMITS.body - lead.length - markers.join('\n').length - 40);
  meta = shorten(meta, room);
  const body = `${lead}\n\n\`\`\`yaml\n${meta}\n\`\`\`\n\n${markers.join('\n')}\n`;
  return { title, body, labels: labelsFor(report, target) };
}

export function parseMarkers(body) {
  const last = (re) => {
    const all = [...String(body ?? '').matchAll(re)];
    return all.length ? all[all.length - 1][1] : undefined;
  };
  const out = {};
  const id = last(/<!-- papercut-id: ([A-Za-z0-9_-]+) -->/g);
  const fp = last(/<!-- papercut-fp: ([0-9a-f]{16}) -->/g);
  const place = last(/<!-- papercut-place: ([A-Za-z0-9%._~!*'()-]+) -->/g);
  if (place) {
    try { out.place = JSON.parse(decodeURIComponent(place)); } catch { /* a broken marker is no place */ }
  }
  if (id) out.id = id;
  if (fp) out.fp = fp;
  return out;
}
