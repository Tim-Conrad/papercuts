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
  client = githubClient({ credential: { token: async () => gh.token, describe: () => 'test' }, apiBase: gh.apiBase, uploadBase: gh.apiBase, assetHosts: [new URL(gh.apiBase).host] });
  home = mkdtempSync(join(tmpdir(), 'pc-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'pc-repo-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Tim-Conrad/shop.git'], { cwd });
});
afterEach(() => gh.close());

async function cli(...argv) {
  return cliEnv({}, ...argv);
}

async function cliEnv(extra, ...argv) {
  let out = '';
  const code = await run(argv, { env: { HOME: home, ...extra }, cwd, client, stdout: { write: (s) => { out += s; } } });
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
    assert.equal(execFileSync('node', ['bin/papercuts.js', flag]).toString(), '0.2.0\n');
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
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'papercuts', 'config.json'), 'utf8')), { target: 'per-project', credential: 'gh' });
});

test('setup prints scope', async () => {
  const g = await cli('setup', '--target', 'central', '--repo', 'Tim-Conrad/inbox', '--hooks', 'none');
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /all scopes of your gh login/);
  const c = await cli('setup', '--target', 'central', '--repo', 'Tim-Conrad/inbox', '--hooks', 'none', '--credential', 'file', '--token-file', '/t');
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /Issues: read and write/);
  assert.match(c.out, /only Tim-Conrad\/inbox/);
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

test('setup writes atomically and keeps a broken settings file', async () => {
  mkdirSync(join(home, '.claude'));
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, '{ broken');
  const { code, out } = await cli('setup', '--target', 'per-project', '--hooks', 'claude');
  assert.equal(code, 1);
  assert.match(out, /settings\.json is not valid JSON/);
  assert.equal(readFileSync(settings, 'utf8'), '{ broken');
  writeFileSync(settings, '{}');
  assert.equal((await cli('setup', '--target', 'per-project', '--hooks', 'claude,codex')).code, 0);
  const { readdirSync } = await import('node:fs');
  for (const d of [join(home, '.claude'), join(home, '.codex'), join(home, '.config', 'papercuts')]) {
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith('.tmp')), []);
  }
});

test('hook command uses papercuts from PATH first, then the stored path', async () => {
  assert.equal((await cli('setup', '--target', 'per-project', '--hooks', 'claude')).code, 0);
  const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const cmd = s.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /command -v papercuts/);
  assert.ok(cmd.includes(process.execPath));
  assert.ok(cmd.includes('bin/papercuts.js'));
  const again = await cli('setup', '--target', 'per-project', '--hooks', 'claude');
  assert.equal(again.code, 0);
  const s2 = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s2.hooks.SessionStart.length, 1);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const issueWith = (body) => {
  const list = (gh.state.issues['Tim-Conrad/shop'] ??= []);
  const n = gh.state.next++;
  list.push({ number: n, title: 'papercut: x', body, state: 'open', labels: [{ name: 'papercut' }], html_url: `https://github.com/Tim-Conrad/shop/issues/${n}`, comments: 0, commentList: [] });
  return n;
};

test('setup writes the credential choice', async () => {
  assert.equal((await cli('setup', '--target', 'per-project', '--hooks', 'none')).code, 0);
  const file = join(home, '.config', 'papercuts', 'config.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).credential, 'gh');
  const r = await cli('setup', '--target', 'per-project', '--hooks', 'none', '--credential', 'file', '--token-file', '/x/token');
  assert.equal(r.code, 0);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(c.credential, 'file');
  assert.equal(c.tokenFile, '/x/token');
  assert.equal((await cli('setup', '--target', 'per-project', '--credential', 'file')).code, 2);
  assert.equal((await cli('setup', '--target', 'per-project', '--credential', 'app')).code, 2);
});

test('shot downloads the picture of a papercut', async () => {
  gh.state.uploads.push({ bytes: PNG });
  const n = issueWith(`x\n\n![papercut](${gh.apiBase}/assets/1)\n`);
  const out = join(home, 'p.png');
  const r = await cli('shot', String(n), '--out', out);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^shot: /m);
  assert.deepEqual(readFileSync(out), PNG);
});

test('shot never sends the token to a host outside the allow list', async () => {
  const n = issueWith('x\n\n![papercut](https://evil.example/a.png)\n');
  const r = await cli('shot', String(n));
  assert.equal(r.code, 1);
  assert.match(r.out, /^error: /m);
  assert.ok(!gh.state.requests.some((q) => q.path === '/a.png'));
});

test('shot without picture exits 1 with help', async () => {
  const n = issueWith('no picture here');
  const r = await cli('shot', String(n));
  assert.equal(r.code, 1);
  assert.match(r.out, /^error: papercut #\d+ has no picture/m);
  assert.match(r.out, /^help: /m);
});

test('import files a saved report once', async () => {
  const file = join(home, 'r.json');
  writeFileSync(file, JSON.stringify({ from: 'human', report: { id: 'saved-1', kind: 'bug', text: 'saved while offline', repo: 'Tim-Conrad/shop' } }));
  const a = await cli('import', file);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /^papercut: #\d+ created$/m);
  const b = await cli('import', file);
  assert.equal(b.code, 0);
  assert.equal(gh.state.issues['Tim-Conrad/shop'].length, 1);
  writeFileSync(file, 'not json');
  assert.equal((await cli('import', file)).code, 1);
});

const placeBody = () => {
  const place = { url: 'https://shop.lab.t7d.dev/cart?x=1', hash: '#cart', scrollX: 0, scrollY: 300, viewport: { width: 412, height: 860 }, selector: '#buy', storage: { theme: 'dark' } };
  return `x\n\n<!-- papercut-place: ${encodeURIComponent(JSON.stringify(place))} -->\n`;
};

test('replay without uv prints the replay data', async () => {
  const n = issueWith(placeBody());
  const r = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(n));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /url: "?https:\/\/shop\.lab\.t7d\.dev\/cart\?x=1#cart/);
  assert.match(r.out, /viewport: 412x860/);
  assert.match(r.out, /selector: #buy/);
  assert.match(r.out, /^help\[/m);
});

test('replay --base replaces the origin', async () => {
  const n = issueWith(placeBody());
  const r = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(n), '--base', 'https://shop-dev.lab.t7d.dev');
  assert.match(r.out, /url: "?https:\/\/shop-dev\.lab\.t7d\.dev\/cart\?x=1#cart/);
});

test('replay of a papercut without place exits 1', async () => {
  const n = issueWith('no place');
  const r = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(n));
  assert.equal(r.code, 1);
  assert.match(r.out, /has no place/);
});

test('replay refuses a place that is not http or https', async () => {
  const bad = `x\n\n<!-- papercut-place: ${encodeURIComponent(JSON.stringify({ url: 'javascript:alert(1)', hash: '' }))} -->\n`;
  const n = issueWith(bad);
  const r = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(n));
  assert.equal(r.code, 1);
  assert.match(r.out, /not an http or https URL/);
  const b = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(issueWith(placeBody())), '--base', 'file:///tmp');
  assert.equal(b.code, 2);
});
