// The papercuts CLI for agents. It follows the AXI rules (https://axi.md): TOON on stdout,
// content first, errors with a help line, exit 0 / 1 / 2, no prompts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { toon } from './toon.js';
import { openPapercuts } from './list.js';
import { loadRepoConfig, normalizeFields, checkConfigText, CONFIG_PATH } from './ticket.js';
import { initRepo } from './init.js';
import { normalizeReport, redact, shorten, parseMarkers, KINDS } from './format.js';
import { execFile, execFileSync } from 'node:child_process';
import { fileReport, targetRepo } from './file.js';
import { githubClient, GithubError } from './github.js';
import { credentialFrom } from './credential.js';
import { loadConfig, readConfigFile, configPath, VERSION } from './config.js';
import { repoFromGit } from './repo.js';
import { storeFor, localClient, localRepoName, STORES } from './store.js';
import { relative } from 'node:path';

const BIN = fileURLToPath(new URL('../bin/papercuts.js', import.meta.url));
const SKILL_PATH = fileURLToPath(new URL('../skills/papercuts/SKILL.md', import.meta.url));
const DESCRIPTION = 'One place where you and your agents report friction. Each papercut is a GitHub issue, or a row in a local file.';
const VIEW_LIMIT = 800;
const HOME_ROWS = 20;
const HOOK_ROWS = 10;

const COMMANDS = {
  add: {
    usage: 'papercuts add <kind> "<text>" [--where <place>] [--field <id>=<value>]... [--repo <owner/name>]',
    about: 'Report one papercut as an agent. A repeat of an open papercut adds +1 to it.',
    args: ['kind', 'text'],
    flags: { where: 'string', repo: 'string', field: 'list' },
    defaults: ['--where: empty', '--field: the fields of .github/papercuts.json (run `papercuts config`)', '--repo: the git remote "origin" of this folder', `kinds: ${KINDS.join(', ')}`],
    examples: ['papercuts add tool "gh-axi pr view drops the PR body" --where "gh-axi pr view"',
      'papercuts add path "AGENTS.md names scripts/check.sh, but the file is tools/check.sh"',
      'papercuts add rule "Two rules disagree about the branch name" --repo Tim-Conrad/lab'],
  },
  list: {
    usage: 'papercuts list [--from agent|human] [--kind <kind>] [--fields <a,b>] [--repo <owner/name>]',
    about: 'List the open papercuts of the repo.',
    args: [],
    flags: { from: 'string', kind: 'string', fields: 'string', repo: 'string' },
    defaults: ['--from: both', '--kind: all', '--fields: id,kind,from,title,count (extra: url,created,where)'],
    examples: ['papercuts list', 'papercuts list --from human', 'papercuts list --kind tool --fields url'],
  },
  view: {
    usage: 'papercuts view <id> [--full] [--repo <owner/name>]',
    about: 'Show one papercut with its context.',
    args: ['id'],
    flags: { full: 'bool', repo: 'string' },
    defaults: [`--full: off, the body is cut at ${VIEW_LIMIT} chars`],
    examples: ['papercuts view 12', 'papercuts view 12 --full'],
  },
  done: {
    usage: 'papercuts done <id> --fix "<what changed>" [--repo <owner/name>]',
    about: 'Close a papercut with a note about the fix. A closed papercut is a no-op.',
    args: ['id'],
    flags: { fix: 'string', repo: 'string' },
    required: ['fix'],
    defaults: ['--fix: required'],
    examples: ['papercuts done 12 --fix "gh-axi pr view prints the body since commit abc1234"'],
  },
  comment: {
    usage: 'papercuts comment <id> "<text>" [--repo <owner/name>]',
    about: 'Add a comment to a papercut, for example options for the owner. It stays open.',
    args: ['id', 'text'],
    flags: { repo: 'string' },
    defaults: ['secrets in the text are redacted'],
    examples: ['papercuts comment 12 "Option A: rename the script. Option B: fix the path in AGENTS.md."'],
  },
  config: {
    usage: 'papercuts config [--file <path>] [--check] [--repo <owner/name>]',
    about: 'Show the ticket config of the repo (.github/papercuts.json): kinds, fields, presets, labels, warnings.',
    args: [],
    flags: { check: 'bool', repo: 'string', file: 'string' },
    defaults: ['--check: exit 1 if the config has a warning (for CI)', '--file: check a local file offline, before the push', 'without --file: reads the default branch on GitHub, like the relay'],
    examples: ['papercuts config', 'papercuts config --file .github/papercuts.json --check', 'papercuts config --check'],
  },
  init: {
    usage: 'papercuts init [--store github|local]',
    about: 'Set up papercuts in the repo of an app: a starter .github/papercuts.json, the AGENTS.md block, and the steps for your stack.',
    args: [],
    flags: { store: 'string' },
    defaults: ['--store: github (each papercut is an issue); local keeps papercuts in .papercuts/papercuts.db, gitignored, without GitHub',
      'keeps your edits: it adds only what is missing and refreshes an outdated AGENTS.md block'],
    examples: ['papercuts init', 'papercuts init --store local'],
  },
  shot: {
    usage: 'papercuts shot <id> [--out <file>] [--repo <owner/name>]',
    about: 'Save the picture of a papercut as a PNG file.',
    args: ['id'],
    flags: { out: 'string', repo: 'string' },
    defaults: ['--out: papercut-<id>.png in this folder', 'PAPERCUTS_RELAY_INTERNAL: unset, then relay pictures come from their public URL'],
    examples: ['papercuts shot 12', 'papercuts shot 12 --out /tmp/p12.png'],
  },
  replay: {
    usage: 'papercuts replay <id> [--out <file>] [--base <url>] [--repo <owner/name>]',
    about: 'Show what the reporter saw: the page with the same size, place and storage, the element in a red frame.',
    args: ['id'],
    flags: { out: 'string', base: 'string', repo: 'string' },
    defaults: ['--out: papercut-<id>.replay.png in this folder', '--base: the origin of the report', 'needs uv for the picture, else it prints the replay data'],
    examples: ['papercuts replay 12', 'papercuts replay 12 --base https://shop-dev.lab.t7d.dev'],
  },
  import: {
    usage: 'papercuts import <file.json>',
    about: 'File a report that the widget saved as a file (?papercuts=download). A second import is a no-op.',
    args: ['file'],
    flags: {},
    defaults: ['the file holds {"from": "human", "report": {...}}'],
    examples: ['papercuts import ~/Downloads/papercut-2026-11-11.json'],
  },
  setup: {
    usage: 'papercuts setup --target per-project|central [--repo <owner/name>] [--credential gh|file] [--token-file <path>] [--hooks claude,codex|none]',
    about: 'Choose where papercuts go, the GitHub credential, and show papercuts at the start of each agent session.',
    args: [],
    flags: { target: 'string', repo: 'string', hooks: 'string', credential: 'string', 'token-file': 'string' },
    required: ['target'],
    defaults: ['--target: required', '--repo: required for central', '--credential: gh (the gh login; can upload pictures)',
      '--token-file: required for --credential file', '--hooks: claude,codex'],
    examples: ['papercuts setup --target per-project', 'papercuts setup --target central --repo Tim-Conrad/papercuts-inbox',
      'papercuts setup --target per-project --credential file --token-file ~/.config/papercuts/token', 'papercuts setup --target per-project --hooks none'],
  },
  doctor: {
    usage: 'papercuts doctor [--repo <owner/name>]',
    about: 'Check the credential and the access to the target repo.',
    args: [],
    flags: { repo: 'string' },
    defaults: ['--repo: the git remote "origin" of this folder'],
    examples: ['papercuts doctor', 'papercuts doctor --repo Tim-Conrad/lab'],
  },
  serve: {
    usage: 'papercuts serve',
    about: 'Start the relay. It serves /papercuts.js and files the reports of the widget.',
    args: [],
    flags: {},
    defaults: ['PORT: 8000', 'PAPERCUTS_ORIGINS: https://*.lab.t7d.dev', 'PAPERCUTS_REPOS: Tim-Conrad/*',
      'PAPERCUTS_TOKEN_FILE: unset, then the gh login is used'],
    examples: ['papercuts serve', 'PORT=8787 PAPERCUTS_ORIGINS="http://localhost:*" papercuts serve'],
  },
  skill: {
    usage: 'papercuts skill [--check] [--path <file>]',
    about: 'Write the agent skill from the current help, or check that it is current.',
    args: [],
    flags: { check: 'bool', path: 'string' },
    defaults: ['--path: skills/papercuts/SKILL.md in the papercuts package'],
    examples: ['papercuts skill', 'papercuts skill --check'],
  },
};
const HOME_FLAGS = { repo: 'string', hook: 'bool' };

class Exit extends Error {
  constructor(code, error, help) {
    super(error);
    this.code = code;
    this.help = help;
  }
}
const usageError = (error, help) => new Exit(2, error, help);
const runError = (error, help) => new Exit(1, error, help);

function tilde(path, env) {
  const home = env.HOME || homedir();
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

function parse(argv) {
  let command = null;
  let rest = argv;
  if (argv[0] && !argv[0].startsWith('-')) {
    if (!COMMANDS[argv[0]]) {
      throw usageError(`unknown command "${argv[0]}"`, `commands: ${Object.keys(COMMANDS).join(', ')}. Run \`papercuts --help\``);
    }
    command = argv[0];
    rest = argv.slice(1);
  }
  const spec = command ? COMMANDS[command].flags : HOME_FLAGS;
  const flags = {};
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--help' || token === '-h') { flags.help = true; continue; }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split(/=(.*)/s);
      if (!spec[name]) {
        const valid = Object.keys(spec).map((f) => `--${f}`).concat('--help').join(', ');
        throw usageError(`unknown flag --${name} for \`${command || 'papercuts'}\``, `valid flags: ${valid}`);
      }
      if (spec[name] === 'bool') { flags[name] = true; continue; }
      const value = inline ?? rest[++i];
      if (value === undefined) throw usageError(`--${name} needs a value`, `Run \`papercuts ${command || ''} --help\``.replace('  ', ' '));
      if (spec[name] === 'list') (flags[name] ??= []).push(value);
      else flags[name] = value;
      continue;
    }
    args.push(token);
  }
  return { command, flags, args };
}

function commandHelp(name) {
  const c = COMMANDS[name];
  return toon({ usage: c.usage, about: c.about, defaults: c.defaults, examples: c.examples });
}

function homeHelpLines(repoFlag) {
  const r = repoFlag ? ` --repo ${repoFlag}` : '';
  return [
    `Run \`papercuts view <id>${r}\` to read one papercut`,
    `Run \`papercuts done <id> --fix "<what changed>"${r}\` after a fix`,
    `Run \`papercuts add <kind> "<text>"${r}\` to report friction (kinds: ${KINDS.join(', ')})`,
  ];
}

export function skillText() {
  const commands = Object.entries(COMMANDS).filter(([n]) => !['serve', 'skill'].includes(n))
    .map(([, c]) => `- \`${c.usage}\`: ${c.about}`).join('\n');
  return `---
name: papercuts
description: Use when a tool, a path, a rule or a page gives you friction, or when the session start lists open papercuts. Report each papercut with one command, and fix and close open ones.
---

# Papercuts

Papercuts is the one place where Tim and his agents report friction. Each papercut is a GitHub issue with the label \`papercut\`. If \`.github/papercuts.json\` sets \`"store": "local"\`, each papercut is a row in \`.papercuts/papercuts.db\` instead, and the commands work the same.

## When to report

Report a papercut when something costs you time and a small change can fix it:

- A tool fails, or prints output that you cannot use (\`tool\`).
- A rule in AGENTS.md or CLAUDE.md is unclear or contradicts another rule (\`rule\`).
- A path in a doc or a script is wrong (\`path\`).
- A page has a bug, a layout problem or wrong text (\`bug\`, \`ux\`, \`copy\`).

Do not stop your task to report. Report in one command and continue. A repeat adds +1 to the open papercut, so do not search first.

## Commands

${commands}

Run \`papercuts\` with no arguments to see the open papercuts of the current repo.

## Fix and close

1. Run \`papercuts view <id>\` to read the papercut and its context.
2. Fix it with the normal rules of the repo: a branch, a test first for a bug, the checks.
3. Run \`papercuts done <id> --fix "<what changed, and the commit>"\`.

If a papercut needs a decision from Tim, do not close it. Write two or three options with \`papercuts comment <id> "<options>"\`.

## Rules

- Write one sentence. Name the tool, the file or the page.
- Never put a token, a password or a key into a papercut. Papercuts redacts known secret patterns, but not all of them.
`;
}

function configView(c, label, help) {
  const out = { config: label, kinds: c.config.kinds.join(', ') };
  out.fields = c.config.fields.length
    ? c.config.fields.map((f) => ({ id: f.id, label: f.label, required: f.required, options: (f.options || []).join('|') }))
    : 'none';
  out.presets = c.config.presets.length ? c.config.presets : 'none';
  out.labels = [...c.config.labels, ...Object.entries(c.config.labelsByKind).map(([k, v]) => `${k}: ${v.join(' ')}`)].join(', ') || 'none';
  out.assignees = c.config.assignees.join(', ') || 'none';
  if (c.warnings.length) out.warnings = c.warnings;
  out.help = help;
  return out;
}

function issueNumber(arg, command) {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) throw usageError(`<id> must be an issue number, not "${arg}"`, `usage: ${COMMANDS[command].usage}`);
  return n;
}

const REPLAY_PY = fileURLToPath(new URL('../replay/replay.py', import.meta.url));

function hasUv(env) {
  return new Promise((resolve) => execFile('uv', ['--version'], { env, timeout: 10000 }, (err) => resolve(!err)));
}

// Playwright runs through uv, so papercuts needs no npm dependency for it.
function runReplay(data, env) {
  return new Promise((resolve, reject) => {
    const child = execFile('uv', ['run', '--no-project', '--with', 'playwright', 'python3', REPLAY_PY], { env, timeout: 180000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(runError(`replay failed: ${String(stderr || err.message).trim().split('\n').pop()}`, 'Run `uv run --with playwright playwright install chromium`, or set PAPERCUTS_CHROME to a Chrome binary'));
        resolve(String(stdout).trim().split('\n').pop());
      });
    child.stdin.end(JSON.stringify(data));
  });
}

async function openRows(client, repo, label) {
  return (await openPapercuts(client, repo, label)).map((p) => ({
    id: p.issue, kind: p.kind, from: p.from, title: p.title, count: 1 + p.plus, url: p.url, created: p.created, where: p.where,
  }));
}

function scopeLines(target, centralRepo) {
  return target === 'central'
    ? [`fine-grained token, repository access: ${centralRepo}, and the app repos for their ticket config`, 'permissions: Issues: read and write (inbox), Contents: read (app repos, optional)']
    : ['fine-grained token, repository access: each repo in PAPERCUTS_REPOS', 'permissions: Issues: read and write, Contents: read (for .github/papercuts.json)'];
}

// Write a temp file, then rename it, so that a crash never leaves half a settings file.
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function installHook(file, command) {
  let data = {};
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { throw runError(`${file} is not valid JSON`, 'fix the file, then run setup again'); }
  }
  data.hooks ??= {};
  const list = (data.hooks.SessionStart ??= []);
  const isOurs = (h) => /papercuts(\.js)?['"]?\s.*--hook/.test(h.command || '');
  const entry = list.find((e) => (e.hooks || []).some(isOurs));
  if (entry) {
    entry.hooks = entry.hooks.map((h) => (isOurs(h) ? { ...h, command } : h));
  } else {
    list.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] });
  }
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

export async function run(argv, ctx = {}) {
  const env = ctx.env || process.env;
  const cwd = ctx.cwd || process.cwd();
  const stdout = ctx.stdout || process.stdout;
  const print = (obj) => stdout.write(toon(obj) + '\n');
  let parsed;
  try {
    parsed = parse(argv);
    const { command, flags, args } = parsed;
    if (flags.help) {
      stdout.write((command ? commandHelp(command) : toon({ usage: 'papercuts [command] [flags]',
        commands: Object.entries(COMMANDS).map(([n, c]) => ({ command: n, about: c.about })),
        help: ['Run `papercuts <command> --help` for flags and examples'] })) + '\n');
      return 0;
    }
    if (command) {
      const spec = COMMANDS[command];
      if (args.length < spec.args.length) {
        throw usageError(`missing <${spec.args[args.length]}> for \`${command}\``, `usage: ${spec.usage}`);
      }
      if (args.length > spec.args.length) throw usageError(`too many arguments for \`${command}\``, `usage: ${spec.usage}`);
      for (const r of spec.required || []) if (!flags[r]) throw usageError(`--${r} is required for \`${command}\``, `usage: ${spec.usage}`);
    }
    if (command === 'skill') {
      const path = flags.path || SKILL_PATH;
      const text = skillText();
      if (flags.check) {
        const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
        if (current !== text) throw runError(`${tilde(path, env)} is out of date`, 'Run `papercuts skill`');
        print({ skill: `${tilde(path, env)} is current` });
        return 0;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      print({ skill: `wrote ${tilde(path, env)}` });
      return 0;
    }
    if (command === 'setup') {
      if (!['per-project', 'central'].includes(flags.target)) throw usageError(`--target must be per-project or central, not "${flags.target}"`, `usage: ${COMMANDS.setup.usage}`);
      if (flags.target === 'central' && !flags.repo) throw usageError('--repo is required for --target central', 'Run `papercuts setup --target central --repo <owner/name>`');
      const hooks = (flags.hooks ?? 'claude,codex').split(',').map((s) => s.trim()).filter((h) => h && h !== 'none');
      for (const h of hooks) if (!['claude', 'codex'].includes(h)) throw usageError(`unknown hook target "${h}"`, 'use --hooks claude,codex or --hooks none');
      const credential = flags.credential ?? 'gh';
      if (!['gh', 'file'].includes(credential)) throw usageError(`--credential must be gh or file, not "${credential}"`, `usage: ${COMMANDS.setup.usage}`);
      if (credential === 'file' && !flags['token-file']) throw usageError('--token-file is required for --credential file', 'Run `papercuts setup --target <target> --credential file --token-file <path>`');
      const config = { target: flags.target, ...(flags.target === 'central' ? { centralRepo: flags.repo } : {}), credential,
        ...(credential === 'file' ? { tokenFile: flags['token-file'] } : {}) };
      const file = configPath(env);
      writeAtomic(file, JSON.stringify(config, null, 2) + '\n');
      const home = env.HOME || homedir();
      // papercuts from the PATH survives a Node upgrade. The stored path is the fallback.
      const command = `sh -c 'command -v papercuts >/dev/null 2>&1 && exec papercuts --hook || exec "${process.execPath}" "${BIN}" --hook'`;
      const files = { claude: join(home, '.claude', 'settings.json'), codex: join(home, '.codex', 'hooks.json') };
      for (const h of hooks) installHook(files[h], command);
      print({
        config: tilde(file, env),
        target: flags.target + (config.centralRepo ? ` (${config.centralRepo})` : ''),
        hooks: hooks.length ? hooks.map((h) => tilde(files[h], env)) : ['none'],
        credential: credential === 'gh' ? ['the gh login of this host (gh auth login)', 'scope: all scopes of your gh login, wider than issues', 'pictures: upload to the issue works']
          : [`token file ${tilde(flags['token-file'], env)}`, ...scopeLines(flags.target, config.centralRepo), 'pictures: GitHub refuses them, the relay keeps them'],
        help: ['Run `papercuts doctor` to check the credential'],
      });
      return 0;
    }

    if (command === 'init') {
      if (flags.store && !STORES.includes(flags.store)) throw usageError(`--store must be github or local, not "${flags.store}"`, `usage: ${COMMANDS.init.usage}`);
      print(initRepo(cwd, repoFromGit(cwd), env, { store: flags.store }));
      return 0;
    }

    const ownRepo = repoFromGit(cwd);
    const store = storeFor(cwd, env, { repoFlag: flags.repo, ownRepo });
    const local = store.mode === 'local';
    const config = loadConfig(env, readConfigFile(env), { store: store.mode });
    // The local store needs no credential and never talks to GitHub.
    const makeClient = () => (local ? localClient({ dbPath: store.dbPath, root: store.root }) : ctx.client || githubClient({ credential: credentialFrom(config.credential), apiBase: config.github.apiBase, uploadBase: config.github.uploadBase, assetHosts: config.github.assetHosts }));
    const target = local ? { mode: 'per-project' } : config.target;
    if (command === 'serve') {
      const { createRelay } = await import('./relay.js');
      const server = createRelay({ ...config, target }, { client: makeClient() });
      // A local relay runs next to a dev server. It listens only on this machine, so that the LAN cannot read the list.
      const host = env.PAPERCUTS_HOST || (local ? '127.0.0.1' : '0.0.0.0');
      await new Promise((r) => server.listen(config.port, host, r));
      const via = local ? `local store ${store.dbPath}` : `target ${target.mode}, credential ${credentialFrom(config.credential).describe()}`;
      process.stderr.write(`papercuts relay ${VERSION} on ${host}:${config.port}, ${via}, origins ${config.origins.join(' ')}\n`);
      await new Promise(() => {});
    }

    if (command === 'import') {
      let payload;
      try { payload = JSON.parse(readFileSync(args[0], 'utf8')); } catch (e) { throw runError(`cannot read ${args[0]}: ${e.message}`, 'give the JSON file that the widget saved'); }
      const norm = normalizeReport(payload?.report, payload?.from ?? 'human');
      if (!norm.ok) throw runError(norm.error, norm.help);
      const client = makeClient();
      const repoCfg = (await loadRepoConfig(client, norm.report.repo)).config;
      const fields = normalizeFields(payload.report.fields, repoCfg, norm.report.from, norm.report.kind);
      if (!fields.ok) throw runError(fields.error, fields.help);
      norm.report.fields = fields.fields;
      const r = await fileReport(norm.report, { client, target, config: repoCfg });
      if (!r.ok) throw runError(r.error, r.help);
      print({ papercut: r.deduped ? `added +1 to #${r.issue}` : `#${r.issue} created`, url: r.url });
      return 0;
    }

    if (command === 'config' && flags.file) {
      let text;
      try { text = readFileSync(flags.file, 'utf8'); } catch (e) { throw runError(`cannot read ${flags.file}: ${e.code || e.message}`, 'give the path of .github/papercuts.json'); }
      const c = checkConfigText(text);
      print(configView({ found: true, ...c }, `${tilde(flags.file, env)} (local file)`, ['Push the file; the relay reads it from the default branch within 5 minutes']));
      return flags.check && c.warnings.length ? 1 : 0;
    }

    const repo = flags.repo || ownRepo || (local ? localRepoName(store.main) : null);
    if (!repo) {
      if (flags.hook) return 0;
      throw runError('no repo here: this folder has no GitHub remote "origin"', 'Run `papercuts --repo <owner/name>`, or `papercuts init --store local` for a local store');
    }
    const client = makeClient();
    const where = targetRepo({ repo }, target);
    const label = target.mode === 'central' ? `papercut,project:${repo}` : 'papercut';
    const repoLine = local ? `${repo} (local store)` : target.mode === 'central' ? `${repo} (central: ${where})` : repo;
    const storeLine = local ? { store: `local ${relative(cwd, store.dbPath) || store.dbPath}` } : {};

    if (command === 'add') {
      const raw = {};
      for (const f of flags.field || []) {
        const m = f.match(/^([^=]+)=(.*)$/s);
        if (!m) throw usageError(`--field needs id=value, not "${f}"`, 'Run `papercuts config` for the fields of this repo');
        raw[m[1].trim()] = m[2];
      }
      const norm = normalizeReport({ kind: args[0], text: args[1], where: flags.where, repo }, 'agent');
      if (!norm.ok) throw runError(norm.error, norm.help);
      const repoCfg = (await loadRepoConfig(client, repo)).config;
      const fields = normalizeFields(raw, repoCfg, 'agent', norm.report.kind);
      if (!fields.ok) throw runError(fields.error, fields.help);
      norm.report.fields = fields.fields;
      const r = await fileReport(norm.report, { client, target, config: repoCfg });
      if (!r.ok) throw runError(r.error, r.help);
      print({ papercut: r.deduped ? `added +1 to #${r.issue}` : `#${r.issue} created`, url: r.url, ...storeLine });
      return 0;
    }

    if (command === 'view') {
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1) throw usageError(`<id> must be an issue number, not "${args[0]}"`, `usage: ${COMMANDS.view.usage}`);
      const i = await client.getIssue(where, n);
      const body = String(i.body || '');
      const cut = !flags.full && body.length > VIEW_LIMIT;
      const out = {
        papercut: { id: i.number, title: String(i.title).replace(/^papercut: /, ''), state: i.state, url: i.html_url,
          labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(' ') },
        body: cut ? shorten(body, VIEW_LIMIT) : body,
      };
      const r = flags.repo ? ` --repo ${flags.repo}` : '';
      out.help = cut ? [`Run \`papercuts view ${n} --full${r}\` for the whole body`] : [`Run \`papercuts done ${n} --fix "<what changed>"${r}\` after a fix`];
      print(out);
      return 0;
    }

    if (command === 'config') {
      const c = await loadRepoConfig(client, repo);
      print(configView(c, c.found ? `${CONFIG_PATH} of ${repo}` : `no ${CONFIG_PATH} in ${repo}, defaults apply`,
        c.found ? [`Edit ${CONFIG_PATH} on the default branch; the relay reads it within 5 minutes`] : ['Run `papercuts init` to create a starter config']));
      return flags.check && c.warnings.length ? 1 : 0;
    }

    if (command === 'shot') {
      const n = issueNumber(args[0], 'shot');
      const body = String((await client.getIssue(where, n)).body || '');
      const url = (body.match(/!\[papercut\]\(([^)\s]+)\)/) || body.match(/(https?:\/\/\S+\/shots\/[A-Za-z0-9_-]+\.png)/) || [])[1];
      if (!url) throw runError(`papercut #${n} has no picture`, `Run \`papercuts view ${n}\` to read it`);
      let png;
      if (/\/shots\/[A-Za-z0-9_-]+\.png$/.test(url)) {
        // A picture on the relay. From this host, the relay answers on the proxy network without a login.
        const internal = env.PAPERCUTS_RELAY_INTERNAL;
        const from = internal ? internal.replace(/\/$/, '') + new URL(url).pathname : url;
        const res = await fetch(from, { redirect: 'manual', signal: AbortSignal.timeout(30000) }).catch((e) => ({ ok: false, status: 0, statusText: e.message }));
        if (!res.ok) throw runError(`the relay did not give the picture (${res.status})`, 'set PAPERCUTS_RELAY_INTERNAL to the relay address on the proxy network, for example http://172.30.0.250:8000');
        png = Buffer.from(await res.arrayBuffer());
      } else {
        png = await client.download(url);
      }
      const out = flags.out || join(cwd, `papercut-${n}.png`);
      writeFileSync(out, png);
      print({ shot: tilde(out, env), bytes: png.length });
      return 0;
    }

    if (command === 'replay') {
      const n = issueNumber(args[0], 'replay');
      const place = parseMarkers((await client.getIssue(where, n)).body).place;
      if (!place?.url) throw runError(`papercut #${n} has no place`, 'only reports from the widget v0.2 or later have a place');
      const web = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };
      if (!web(place.url)) throw runError(`the place of papercut #${n} is not an http or https URL`, 'replay opens only web pages');
      if (flags.base && !web(flags.base)) throw usageError(`--base must be an http or https URL, not "${flags.base}"`, `usage: ${COMMANDS.replay.usage}`);
      let url = place.url.split('#')[0] + (place.hash || '');
      if (flags.base) {
        const u = new URL(url);
        url = flags.base.replace(/\/$/, '') + u.pathname + u.search + u.hash;
      }
      const data = { url, viewport: place.viewport || { width: 1280, height: 800 }, scrollX: place.scrollX, scrollY: place.scrollY,
        selector: place.selector || '', storage: place.storage || {}, steps: place.steps || [], marks: place.marks || [], out: flags.out || join(cwd, `papercut-${n}.replay.png`) };
      if (await hasUv(env)) {
        const png = await runReplay(data, env);
        print({ replay: tilde(png, env) });
        return 0;
      }
      print({
        replay: { url, viewport: `${data.viewport.width}x${data.viewport.height}`, scroll: `${data.scrollX},${data.scrollY}`,
          selector: data.selector || 'none', storage: Object.keys(data.storage).join(',') || 'none',
          steps: data.steps.map((x) => `click ${x.click}`).join(', ') || 'none',
          marks: data.marks.map((m, i) => (m.selector ? `${i + 1} ${m.selector}` : `${i + 1} box ${m.box.w}x${m.box.h} at ${m.box.x},${m.box.y}`)).join(', ') || 'none' },
        help: ['Install uv for a replay picture (https://docs.astral.sh/uv/)', 'Or open the url in your browser with this viewport, set the storage keys, run the steps, scroll, and look at the selector'],
      });
      return 0;
    }

    if (command === 'comment') {
      const n = issueNumber(args[0], 'comment');
      const text = redact(String(args[1]).trim());
      if (!text) throw usageError('the comment is empty', `usage: ${COMMANDS.comment.usage}`);
      await client.getIssue(where, n);
      await client.comment(where, n, text);
      print({ papercut: `comment added to #${n}` });
      return 0;
    }

    if (command === 'done') {
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1) throw usageError(`<id> must be an issue number, not "${args[0]}"`, `usage: ${COMMANDS.done.usage}`);
      const i = await client.getIssue(where, n);
      if (i.state === 'closed') {
        print({ papercut: `#${n} already closed (no-op)` });
        return 0;
      }
      await client.close(where, n, `Fixed: ${redact(flags.fix)}`);
      print({ papercut: `#${n} closed`, url: i.html_url });
      return 0;
    }

    if (command === 'doctor') {
      const checks = [];
      const credential = credentialFrom(config.credential);
      const check = async (name, fn) => {
        try { checks.push({ check: name, result: 'ok', detail: await fn() }); } catch (e) { checks.push({ check: name, result: 'fail', detail: e.message }); }
      };
      if (local) {
        await check('store', async () => { await client.listOpen(repo, 'papercut'); return `local ${tilde(store.dbPath, env)}`; });
        await check('gitignored', async () => {
          if (!store.isGit) return 'not a git repo, nothing to ignore';
          try {
            execFileSync('git', ['check-ignore', '-q', store.dbPath], { cwd: store.main, stdio: 'ignore', timeout: 5000 });
          } catch {
            throw new Error(`${relative(store.main, store.dbPath)} is not gitignored: add ".papercuts/" to .gitignore, or run \`papercuts init --store local\``);
          }
          return '.papercuts/ is in .gitignore';
        });
        const passed = checks.filter((c) => c.result === 'ok').length;
        print({ checks });
        stdout.write(`checks: ${passed}/${checks.length} passed\n`);
        return passed === checks.length ? 0 : 1;
      }
      await check('credential', async () => (ctx.client ? 'injected' : credential.describe()));
      await check('token valid', async () => `logged in as ${(await client.user()).login}`);
      await check('issue access', async () => {
        const info = await client.repo(where);
        if (info.permissions && !info.permissions.push && !info.permissions.triage) throw new Error(`no write access to ${where}`);
        return where;
      });
      const passed = checks.filter((c) => c.result === 'ok').length;
      print({ checks });
      stdout.write(`checks: ${passed}/${checks.length} passed\n`);
      return passed === checks.length ? 0 : 1;
    }

    // Home view, the hook and list all read the open papercuts.
    let rows = await openRows(client, where, label);
    if (command === 'list') {
      const total = rows.length;
      if (flags.from) rows = rows.filter((r) => r.from === flags.from);
      if (flags.kind) rows = rows.filter((r) => r.kind === flags.kind);
      const extra = flags.fields ? flags.fields.split(',').map((s) => s.trim()) : [];
      const bad = extra.filter((f) => !['url', 'created', 'where'].includes(f));
      if (bad.length) throw usageError(`unknown field ${bad[0]}`, 'extra fields: url, created, where');
      const fields = ['id', 'kind', 'from', 'title', 'count', ...extra];
      const pick = (r) => Object.fromEntries(fields.map((f) => [f, r[f]]));
      const out = rows.length ? { papercuts: rows.map(pick) } : { papercuts: `0 open match in ${repoLine}` };
      out.count = `${rows.length} of ${total} open`;
      print(out);
      return 0;
    }

    const agents = rows.filter((r) => r.from === 'agent').length;
    const short = (r) => ({ id: r.id, kind: r.kind, from: r.from, title: r.title, count: r.count });
    if (flags.hook) {
      if (!rows.length) return 0;
      const out = { papercuts: rows.slice(0, HOOK_ROWS).map(short), count: `${rows.length} open in ${repoLine}` };
      out.help = [`Run \`papercuts\` for details. Fix one with \`papercuts done <id> --fix "<what changed>"\``];
      print(out);
      return 0;
    }
    const out = { bin: tilde(BIN, env), description: DESCRIPTION, repo: repoLine };
    if (rows.length) {
      out.papercuts = rows.slice(0, HOME_ROWS).map(short);
      out.count = `${rows.length} open (${agents} agent, ${rows.length - agents} human)`;
    } else {
      out.papercuts = `0 open in ${repoLine}`;
    }
    const help = homeHelpLines(flags.repo);
    if (rows.length > HOME_ROWS) help.unshift(`Run \`papercuts list\` for all ${rows.length}`);
    out.help = help;
    print(out);
    return 0;
  } catch (e) {
    if (e instanceof Exit) {
      if (parsed?.flags?.hook) return 0;
      stdout.write(toon({ error: e.message, help: e.help }) + '\n');
      return e.code;
    }
    if (e instanceof GithubError) {
      if (parsed?.flags?.hook) return 0;
      const help = e.source === 'local' ? 'Run `papercuts list` for the papercuts in the local store'
        : e.status === 404 ? 'the issue or repo does not exist, or the token cannot see it' : 'Run `papercuts doctor`';
      stdout.write(toon({ error: `${e.source || 'github'}: ${e.status} ${e.message}`, help }) + '\n');
      return 1;
    }
    if (parsed?.flags?.hook) return 0;
    stdout.write(toon({ error: e.message, help: 'Run `papercuts doctor`' }) + '\n');
    return 1;
  }
}

export async function main() {
  return run(process.argv.slice(2));
}
