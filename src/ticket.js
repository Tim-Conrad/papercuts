// The ticket config of a repo (.github/papercuts.json): what a papercut of this app contains.
// A broken part never breaks the page or the report. It falls back to the default and adds a warning.
import { WIDGET_KINDS, KINDS, redact, shorten } from './format.js';

export const CONFIG_PATH = '.github/papercuts.json';
const FIELD_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const KNOWN = ['$schema', 'kinds', 'fields', 'presets', 'labels', 'labelsByKind', 'assignees', 'context', 'lang'];
const LIMITS = { fields: 8, options: 20, presets: 12, labels: 10, label: 50, assignees: 5, text: 300, keys: 50 };

export function defaultConfig() {
  return { kinds: [...WIDGET_KINDS], fields: [], presets: [], labels: [], labelsByKind: {}, assignees: [], context: {}, lang: '' };
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

function labelList(v, where, warn) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { warn(`${where} must be a list of label names`); return []; }
  const ok = v.filter((x) => typeof x === 'string' && x.trim() && x.length <= LIMITS.label);
  if (ok.length !== v.length) warn(`${where}: each label is a text of at most ${LIMITS.label} characters`);
  if (ok.length > LIMITS.labels) warn(`${where}: at most ${LIMITS.labels} labels`);
  return ok.slice(0, LIMITS.labels).map((x) => x.trim());
}

function keyList(v, where, warn) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { warn(`${where} must be a list of localStorage keys`); return undefined; }
  return v.slice(0, LIMITS.keys);
}

export function checkConfig(raw) {
  const warnings = [];
  const warn = (w) => warnings.push(w);
  const config = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('the config must be a JSON object');
    return { config, warnings };
  }
  for (const k of Object.keys(raw)) if (!KNOWN.includes(k)) warn(`unknown key "${k}" (known: ${KNOWN.slice(1).join(', ')})`);

  if (raw.kinds !== undefined) {
    const list = Array.isArray(raw.kinds) ? raw.kinds : [];
    const ok = list.filter((k) => KINDS.includes(k));
    if (!Array.isArray(raw.kinds) || ok.length !== list.length) warn(`kinds: use some of ${KINDS.join(', ')}`);
    if (ok.length) config.kinds = [...new Set(ok)];
  }

  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) warn('fields must be a list');
    const seen = new Set();
    for (const f of Array.isArray(raw.fields) ? raw.fields : []) {
      if (config.fields.length >= LIMITS.fields) { warn(`fields: at most ${LIMITS.fields}, the rest are left out`); break; }
      const id = f && typeof f.id === 'string' ? f.id : '';
      if (!FIELD_ID.test(id) || seen.has(id)) { warn(`fields: id "${id}" must be unique and match ${FIELD_ID}`); continue; }
      const label = str(f.label, 80);
      if (!label) { warn(`fields: "${id}" needs a label`); continue; }
      const field = { id, label, required: f.required === true };
      if (f.options !== undefined) {
        const opts = Array.isArray(f.options) ? f.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim().slice(0, 60)) : [];
        if (!opts.length) { warn(`fields: "${id}" options must be a list of texts`); continue; }
        field.options = [...new Set(opts)].slice(0, LIMITS.options);
      }
      seen.add(id);
      config.fields.push(field);
    }
  }

  if (raw.presets !== undefined) {
    let dropped = !Array.isArray(raw.presets);
    for (const p of Array.isArray(raw.presets) ? raw.presets : []) {
      const text = str(p && p.text, LIMITS.text);
      if (!p || !KINDS.includes(p.kind) || !text) { dropped = true; continue; }
      if (config.presets.length < LIMITS.presets) config.presets.push({ kind: p.kind, text });
      else dropped = true;
    }
    if (dropped) warn(`presets: each needs a kind (${KINDS.join(', ')}) and a text, at most ${LIMITS.presets}`);
  }

  config.labels = labelList(raw.labels, 'labels', warn);
  if (raw.labelsByKind !== undefined) {
    if (!raw.labelsByKind || typeof raw.labelsByKind !== 'object' || Array.isArray(raw.labelsByKind)) warn('labelsByKind must map a kind to a list of labels');
    else {
      for (const [k, v] of Object.entries(raw.labelsByKind)) {
        if (!KINDS.includes(k)) { warn(`labelsByKind: "${k}" is not a kind`); continue; }
        config.labelsByKind[k] = labelList(v, `labelsByKind.${k}`, warn);
      }
    }
  }

  if (raw.assignees !== undefined) {
    const list = Array.isArray(raw.assignees) ? raw.assignees : [];
    const ok = list.filter((a) => typeof a === 'string' && LOGIN.test(a));
    if (!Array.isArray(raw.assignees) || ok.length !== list.length) warn('assignees: each must be a GitHub login');
    config.assignees = ok.slice(0, LIMITS.assignees);
  }

  if (raw.context !== undefined) {
    if (!raw.context || typeof raw.context !== 'object' || Array.isArray(raw.context)) warn('context must be an object with storage and skipStorage');
    else {
      const storage = keyList(raw.context.storage, 'context.storage', warn);
      const skip = keyList(raw.context.skipStorage, 'context.skipStorage', warn);
      if (storage) config.context.storage = storage;
      if (skip) config.context.skipStorage = skip;
    }
  }

  if (raw.lang !== undefined) {
    if (typeof raw.lang === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(raw.lang)) config.lang = raw.lang;
    else warn('lang must be a language code, for example "en" or "de"');
  }
  return { config, warnings };
}

// Check the field values of one report against the config of its repo.
export function normalizeFields(input, config) {
  const fields = config.fields || [];
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ids = fields.map((f) => f.id);
  const help = ids.length ? `valid fields: ${ids.join(', ')}` : 'this repo has no fields in .github/papercuts.json';
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const field = fields.find((f) => f.id === k);
    if (!field) return { ok: false, error: `unknown field "${k}"`, help };
    const text = shorten(redact(String(v ?? '').replace(/\s+/g, ' ').trim()), LIMITS.text);
    if (!text) continue;
    if (field.options && !field.options.includes(text)) {
      return { ok: false, error: `"${text}" is not an option of "${k}"`, help: `options: ${field.options.join(', ')}` };
    }
    out[k] = text;
  }
  for (const f of fields) {
    if (f.required && !out[f.id]) return { ok: false, error: `field "${f.id}" is required (${f.label})`, help };
  }
  return { ok: true, fields: out };
}

// The config of a repo, read from its default branch. A broken file gives the defaults and warnings.
export async function loadRepoConfig(client, repo) {
  let text;
  try { text = await client.getFile(repo, CONFIG_PATH); } catch (e) {
    // A token without Contents: read (for example the narrow token of the central target) must not lose reports.
    if (e.status === 403 || e.status === 401) {
      return { found: false, config: defaultConfig(), warnings: [`no read access to ${CONFIG_PATH} of ${repo}: give the token Contents: read`] };
    }
    throw e;
  }
  if (text == null) return { found: false, ...checkConfig({}) };
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    return { found: true, config: defaultConfig(), warnings: [`${CONFIG_PATH} is not valid JSON: ${e.message}`] };
  }
  return { found: true, ...checkConfig(raw) };
}

// Labels and assignees of the config for one report.
export function extrasFor(report, config) {
  const labels = [...(config.labels || []), ...((config.labelsByKind || {})[report.kind] || [])];
  return { labels: [...new Set(labels)], assignees: config.assignees || [] };
}
