// The papercuts CLI for agents. It follows the AXI rules (https://axi.md): TOON on stdout,
// content first, errors with a help line, exit 0 / 1 / 2, no prompts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { toon } from './toon.js';
import { normalizeReport, redact, shorten, KINDS } from './format.js';
import { fileReport, targetRepo } from './file.js';
import { githubClient, GithubError } from './github.js';
import { credentialFrom } from './credential.js';
import { loadConfig, readConfigFile, configPath, VERSION } from './config.js';
import { repoFromGit } from './repo.js';

const BIN = fileURLToPath(new URL('../bin/papercuts.js', import.meta.url));
const SKILL_PATH = fileURLToPath(new URL('../skills/papercuts/SKILL.md', import.meta.url));
const DESCRIPTION = 'One place where you and your agents report friction. Each papercut is a GitHub issue.';
const VIEW_LIMIT = 800;
const HOME_ROWS = 20;
const HOOK_ROWS = 10;

const COMMANDS = {
  add: {
    usage: 'papercuts add <kind> "<text>" [--where <place>] [--repo <owner/name>]',
    about: 'Report one papercut as an agent. A repeat of an open papercut adds +1 to it.',
    args: ['kind', 'text'],
    flags: { where: 'string', repo: 'string' },
    defaults: ['--where: empty', '--repo: the git remote "origin" of this folder', `kinds: ${KINDS.join(', ')}`],
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
  setup: {
    usage: 'papercuts setup --target per-project|central [--repo <owner/name>] [--hooks claude,codex|none]',
    about: 'Choose where papercuts go, and show them at the start of each agent session.',
    args: [],
    flags: { target: 'string', repo: 'string', hooks: 'string' },
    required: ['target'],
    defaults: ['--target: required', '--repo: required for central', '--hooks: claude,codex'],
    examples: ['papercuts setup --target per-project', 'papercuts setup --target central --repo Tim-Conrad/papercuts-inbox',
      'papercuts setup --target per-project --hooks none'],
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
      flags[name] = value;
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

Papercuts is the one place where Tim and his agents report friction. Each papercut is a GitHub issue with the label \`papercut\`.

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

If a papercut needs a decision from Tim, do not close it. Write two or three options as a comment on the issue.

## Rules

- Write one sentence. Name the tool, the file or the page.
- Never put a token, a password or a key into a papercut. Papercuts redacts known secret patterns, but not all of them.
`;
}

async function openRows(client, repo, label) {
  const issues = await client.listOpen(repo, label);
  return Promise.all(issues.map(async (i) => {
    const names = i.labels.map((l) => (typeof l === 'string' ? l : l.name));
    let plus = 0;
    if (i.comments > 0) plus = (await client.comments(repo, i.number)).filter((c) => /^\+1\b/.test(c.body || '')).length;
    return {
      id: i.number,
      kind: (names.find((n) => n.startsWith('kind:')) || 'kind:other').slice(5),
      from: (names.find((n) => n.startsWith('from:')) || 'from:human').slice(5),
      title: String(i.title).replace(/^papercut: /, ''),
      count: 1 + plus,
      url: i.html_url,
      created: i.created_at,
      where: (String(i.body).match(/^where: (.*)$/m) || [])[1] || '',
    };
  }));
}

function scopeLines(target, centralRepo) {
  return target === 'central'
    ? [`fine-grained token, repository access: only ${centralRepo}`, 'permission: Issues: read and write']
    : ['fine-grained token, repository access: each repo in PAPERCUTS_REPOS', 'permission: Issues: read and write'];
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
      const config = { target: flags.target, ...(flags.target === 'central' ? { centralRepo: flags.repo } : {}) };
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
        'token for the relay': scopeLines(flags.target, config.centralRepo),
        'token for the CLI': ['the gh login of this host (gh auth login)'],
        help: ['Run `papercuts doctor` to check the credential'],
      });
      return 0;
    }

    const config = loadConfig(env, readConfigFile(env));
    if (command === 'serve') {
      const { createRelay } = await import('./relay.js');
      const client = ctx.client || githubClient({ credential: credentialFrom(config.credential) });
      const server = createRelay(config, { client });
      await new Promise((r) => server.listen(config.port, '0.0.0.0', r));
      process.stderr.write(`papercuts relay ${VERSION} on :${config.port}, target ${config.target.mode}, credential ${credentialFrom(config.credential).describe()}\n`);
      await new Promise(() => {});
    }

    const repo = flags.repo || repoFromGit(cwd);
    if (!repo) {
      if (flags.hook) return 0;
      throw runError('no repo here: this folder has no GitHub remote "origin"', 'Run `papercuts --repo <owner/name>`');
    }
    const client = ctx.client || githubClient({ credential: credentialFrom(config.credential) });
    const where = targetRepo({ repo }, config.target);
    const label = config.target.mode === 'central' ? `papercut,project:${repo}` : 'papercut';
    const repoLine = config.target.mode === 'central' ? `${repo} (central: ${where})` : repo;

    if (command === 'add') {
      const norm = normalizeReport({ kind: args[0], text: args[1], where: flags.where, repo }, 'agent');
      if (!norm.ok) throw runError(norm.error, norm.help);
      const r = await fileReport(norm.report, { client, target: config.target });
      if (!r.ok) throw runError(r.error, r.help);
      print({ papercut: r.deduped ? `added +1 to #${r.issue}` : `#${r.issue} created`, url: r.url });
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
      const help = e.status === 404 ? 'the issue or repo does not exist, or the token cannot see it' : 'Run `papercuts doctor`';
      stdout.write(toon({ error: `github: ${e.status} ${e.message}`, help }) + '\n');
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
