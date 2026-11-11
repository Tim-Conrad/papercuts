import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeGithub } from './fake-github.js';
import { githubClient } from '../src/github.js';
import { run } from '../src/cli.js';
import { parseRemote } from '../src/repo.js';

let gh, client, home, cwd;
beforeEach(async () => {
  gh = await fakeGithub();
  client = githubClient({ credential: { token: async () => gh.token, describe: () => 'test' }, apiBase: gh.apiBase });
  home = mkdtempSync(join(tmpdir(), 'pc-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'pc-repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Tim-Conrad/shop.git'], { cwd });
});
afterEach(() => gh.close());

async function cli(...argv) {
  let out = '';
  const code = await run(argv, { env: { HOME: home }, cwd, client, stdout: { write: (s) => { out += s; } } });
  return { code, out };
}

test('home view lists open', async () => {
  await cli('add', 'tool', 'gh-axi drops the body', '--where', 'gh-axi');
  const { code, out } = await cli();
  assert.equal(code, 0);
  assert.match(out, /^bin: /m);
  assert.match(out, /^description: One place where you and your agents report friction/m);
  assert.match(out, /^repo: Tim-Conrad\/shop$/m);
  assert.match(out, /papercuts\[1\]\{id,kind,from,title,count\}:\n  1,tool,agent,gh-axi drops the body,1/);
  assert.match(out, /^count: 1 open \(1 agent, 0 human\)$/m);
  assert.match(out, /^help\[\d+\]:/m);
});

test('home empty state', async () => {
  const { code, out } = await cli();
  assert.equal(code, 0);
  assert.match(out, /^papercuts: 0 open in Tim-Conrad\/shop$/m);
});

test('home outside a repo', async () => {
  let out = '';
  const code = await run([], { env: { HOME: home }, cwd: home, client, stdout: { write: (s) => { out += s; } } });
  assert.equal(code, 1);
  assert.match(out, /^error: no repo here/m);
  assert.match(out, /^help: Run `papercuts --repo <owner\/name>`/m);
});

test('add creates then +1', async () => {
  const a = await cli('add', 'tool', 'gh-axi drops the body');
  assert.equal(a.code, 0);
  assert.match(a.out, /^papercut: #1 created$/m);
  const b = await cli('add', 'tool', 'gh-axi drops the body');
  assert.match(b.out, /^papercut: added \+1 to #1$/m);
  const home = await cli();
  assert.match(home.out, /1,tool,agent,gh-axi drops the body,2/);
});

test('home view shows a papercut created seconds ago although GitHub lists lag', async () => {
  gh.state.lag = true;
  await cli('add', 'tool', 'gh-axi drops the body');
  const { out } = await cli();
  assert.match(out, /^count: 1 open/m);
});

test('add with --repo outside git', async () => {
  let out = '';
  const code = await run(['add', 'path', 'x', '--repo', 'a/b'], { env: { HOME: home }, cwd: home, client, stdout: { write: (s) => { out += s; } } });
  assert.equal(code, 0, out);
  assert.equal(gh.state.issues['a/b'].length, 1);
});

test('add rejected kind exits 1 with help', async () => {
  const { code, out } = await cli('add', 'nope', 'x');
  assert.equal(code, 1);
  assert.match(out, /^error: unknown kind "nope"/m);
  assert.match(out, /^help: /m);
  assert.equal(gh.state.requests.length, 0);
});

test('list filters', async () => {
  await cli('add', 'tool', 'one');
  await cli('add', 'path', 'two');
  const { out } = await cli('list', '--kind', 'path');
  assert.match(out, /papercuts\[1\]/);
  assert.match(out, /two/);
  assert.match(out, /^count: 1 of 2 open$/m);
});

test('done twice is no-op exit 0', async () => {
  await cli('add', 'tool', 'x');
  const a = await cli('done', '1', '--fix', 'fixed the flag');
  assert.equal(a.code, 0);
  assert.match(a.out, /^papercut: #1 closed$/m);
  assert.equal(gh.state.issues['Tim-Conrad/shop'][0].state, 'closed');
  const b = await cli('done', '1', '--fix', 'again');
  assert.equal(b.code, 0);
  assert.match(b.out, /^papercut: #1 already closed \(no-op\)$/m);
});

test('done needs --fix', async () => {
  const { code, out } = await cli('done', '1');
  assert.equal(code, 2);
  assert.match(out, /^error: --fix is required/m);
  assert.equal(gh.state.requests.length, 0);
});

test('view truncates with hint', async () => {
  await cli('add', 'bug', 'long one', '--repo', 'Tim-Conrad/shop');
  gh.state.issues['Tim-Conrad/shop'][0].body = 'b'.repeat(2000);
  const { out } = await cli('view', '1');
  assert.match(out, /\(truncated, 2000 chars total\)/);
  assert.match(out, /Run `papercuts view 1 --full`/);
});

test('view --full no hint', async () => {
  await cli('add', 'bug', 'long one');
  gh.state.issues['Tim-Conrad/shop'][0].body = 'b'.repeat(2000);
  const { out } = await cli('view', '1', '--full');
  assert.ok(!out.includes('truncated'));
  assert.ok(!out.includes('--full`'));
});

test('unknown flag exit 2 and no request', async () => {
  const { code, out } = await cli('add', 'tool', 'x', '--stat');
  assert.equal(code, 2);
  assert.match(out, /^error: unknown flag --stat for `add`$/m);
  assert.match(out, /^help: valid flags: /m);
  assert.equal(gh.state.requests.length, 0);
});

test('missing text exit 2', async () => {
  const { code, out } = await cli('add', 'tool');
  assert.equal(code, 2);
  assert.match(out, /^error: /m);
});

test('unknown command exit 2', async () => {
  const { code } = await cli('frobnicate');
  assert.equal(code, 2);
});

test('subcommand help', async () => {
  const { code, out } = await cli('add', '--help');
  assert.equal(code, 0);
  assert.match(out, /usage: papercuts add <kind> "<text>"/);
  assert.match(out, /examples\[/);
  assert.equal(gh.state.requests.length, 0);
});

test('version fast path', () => {
  for (const flag of ['-v', '-V', '--version']) {
    assert.equal(execFileSync('node', ['bin/papercuts.js', flag]).toString(), '0.1.0\n');
  }
});

test('setup is idempotent', async () => {
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'));
  writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'gh-axi' }] }] }, model: 'x' }));
  for (let i = 0; i < 2; i++) {
    const { code } = await cli('setup', '--target', 'per-project', '--hooks', 'claude,codex');
    assert.equal(code, 0);
  }
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'x');
  const cmds = s.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
  assert.equal(cmds.filter((c) => c.includes('papercuts')).length, 1);
  assert.ok(cmds.includes('gh-axi'));
  const codex = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.hooks.SessionStart.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'papercuts', 'config.json'), 'utf8')), { target: 'per-project' });
});

test('setup prints scope', async () => {
  const c = await cli('setup', '--target', 'central', '--repo', 'Tim-Conrad/inbox', '--hooks', 'none');
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /Issues: read and write/);
  assert.match(c.out, /Tim-Conrad\/inbox/);
  const p = await cli('setup', '--target', 'central', '--hooks', 'none');
  assert.equal(p.code, 2);
  assert.match(p.out, /^error: --repo is required for --target central/m);
});

test('central mode files to inbox and lists by project', async () => {
  await cli('setup', '--target', 'central', '--repo', 'Tim-Conrad/inbox', '--hooks', 'none');
  await cli('add', 'tool', 'x');
  assert.equal(gh.state.issues['Tim-Conrad/inbox'].length, 1);
  const { out } = await cli();
  assert.match(out, /^repo: Tim-Conrad\/shop \(central: Tim-Conrad\/inbox\)$/m);
  assert.match(out, /papercuts\[1\]/);
});

test('hook prints nothing when empty', async () => {
  const { code, out } = await cli('--hook');
  assert.equal(code, 0);
  assert.equal(out, '');
});

test('hook prints compact view when open', async () => {
  await cli('add', 'tool', 'x');
  const { out } = await cli('--hook');
  assert.match(out, /papercuts\[1\]/);
  assert.ok(out.trim().split('\n').length <= 15);
});

test('doctor reports checks', async () => {
  const { code, out } = await cli('doctor');
  assert.equal(code, 0, out);
  assert.match(out, /^checks: 3\/3 passed$/m);
});

test('skill --check detects drift', async () => {
  const path = join(home, 'SKILL.md');
  assert.equal((await cli('skill', '--path', path)).code, 0);
  assert.ok(existsSync(path));
  assert.equal((await cli('skill', '--check', '--path', path)).code, 0);
  writeFileSync(path, 'old');
  const drift = await cli('skill', '--check', '--path', path);
  assert.equal(drift.code, 1);
  assert.match(drift.out, /^error: .*out of date/m);
});

test('repoFromGit parses ssh and https', () => {
  assert.equal(parseRemote('git@github.com:Tim-Conrad/shop.git'), 'Tim-Conrad/shop');
  assert.equal(parseRemote('https://github.com/Tim-Conrad/shop'), 'Tim-Conrad/shop');
  assert.equal(parseRemote('https://github.com/Tim-Conrad/my.site.git\n'), 'Tim-Conrad/my.site');
  assert.equal(parseRemote('https://gitlab.com/a/b'), null);
});
