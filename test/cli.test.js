import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeGithub } from './fake-github.js';
import { githubClient, GithubError } from '../src/github.js';
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
    assert.equal(execFileSync('node', ['bin/papercuts.js', flag]).toString(), '0.4.1\n');
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
  assert.match(c.out, /Tim-Conrad\/inbox, and the app repos/);
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

test('doctor accepts a GitHub App installation token (no /user)', async () => {
  const app = { ...client, user: async () => { throw new GithubError(403, 'Resource not accessible by integration'); }, rateLimit: async () => ({}) };
  let out = '';
  const code = await run(['doctor'], { env: { HOME: home }, cwd, client: app, stdout: { write: (s) => { out += s; } } });
  assert.equal(code, 0, out);
  assert.match(out, /installation token/);
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

test('replay prints the replay steps', async () => {
  const place = { url: 'https://shop.lab.t7d.dev/', hash: '', steps: [{ click: '.karte[data-id="k12"]' }] };
  const n = issueWith(`x\n\n<!-- papercut-place: ${encodeURIComponent(JSON.stringify(place))} -->\n`);
  const r = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(n));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /steps: click \.karte\[data-id="k12"\]/);
});

const SHOP_CFG = { fields: [{ id: 'expected', label: 'What did you expect?', required: true }], labels: ['area:web'] };

test('add --field fills the fields of the repo config, and the config labels apply', async () => {
  gh.state.files['Tim-Conrad/shop'] = { '.github/papercuts.json': JSON.stringify(SHOP_CFG) };
  const r = await cli('add', 'tool', 'the export is slow', '--field', 'expected=It takes one second');
  assert.equal(r.code, 0, r.out);
  const issue = gh.state.issues['Tim-Conrad/shop'].at(-1);
  assert.match(issue.body, /\*\*What did you expect\?\*\* It takes one second/);
  assert.ok(issue.labels.some((l) => l.name === 'area:web'));
  const missing = await cli('add', 'tool', 'another one');
  assert.equal(missing.code, 1);
  assert.match(missing.out, /^error: field "expected" is required/m);
  assert.match(missing.out, /^help: valid fields: expected/m);
  const bad = await cli('add', 'tool', 'x', '--field', 'novalue');
  assert.equal(bad.code, 2);
  assert.match(bad.out, /--field needs id=value/);
});

test('config shows the repo config, --check fails on warnings', async () => {
  let r = await cli('config');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^config: no \.github\/papercuts\.json in Tim-Conrad\/shop, defaults apply$/m);
  gh.state.files['Tim-Conrad/shop'] = { '.github/papercuts.json': JSON.stringify({ ...SHOP_CFG, surprise: 1 }) };
  r = await cli('config');
  assert.equal(r.code, 0);
  assert.match(r.out, /fields\[1\]\{id,label,required,options\}:\n  expected,What did you expect\?,true,/);
  assert.match(r.out, /warnings\[1\]:\n  unknown key "surprise"/);
  r = await cli('config', '--check');
  assert.equal(r.code, 1);
  gh.state.files['Tim-Conrad/shop'] = { '.github/papercuts.json': JSON.stringify(SHOP_CFG) };
  assert.equal((await cli('config', '--check')).code, 0);
});

test('init writes the starter config and the AGENTS block once, and names the stack', async () => {
  writeFileSync(join(cwd, 'requirements.txt'), 'fastapi==0.120\nuvicorn\n');
  const r = await cli('init');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^stack: fastapi$/m);
  assert.match(r.out, /\.github\/papercuts\.json: created/);
  assert.match(r.out, /AGENTS\.md: (added|created with) the papercuts block/);
  assert.match(r.out, /PAPERCUTS_URL/);
  const cfg = JSON.parse(readFileSync(join(cwd, '.github', 'papercuts.json'), 'utf8'));
  assert.ok(cfg.$schema.includes('papercuts.schema.json'));
  assert.ok(Array.isArray(cfg.presets));
  assert.match(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /## Papercuts/);
  const again = await cli('init');
  assert.equal(again.code, 0);
  assert.match(again.out, /\.github\/papercuts\.json: exists, not changed/);
  assert.match(again.out, /AGENTS\.md: has the current papercuts block, not changed/);
  assert.equal((readFileSync(join(cwd, 'AGENTS.md'), 'utf8').match(/## Papercuts/g) || []).length, 1);
});

test('init detects nginx, vite and a plain page', async () => {
  const { mkdtempSync: mk } = await import('node:fs');
  for (const [file, text, stack] of [['nginx.conf', 'server {}', 'nginx'], ['package.json', '{"devDependencies":{"vite":"6"}}', 'vite'], ['index.html', '<html></html>', 'static']]) {
    const dir = mk(join(tmpdir(), 'pc-init-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Tim-Conrad/shop.git'], { cwd: dir });
    writeFileSync(join(dir, file), text);
    let out = '';
    const code = await run(['init'], { env: { HOME: home }, cwd: dir, client, stdout: { write: (s) => { out += s; } } });
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`^stack: ${stack}$`, 'm'));
  }
});

test('replay prints the marks', async () => {
  const place = { url: 'https://shop.lab.t7d.dev/', hash: '', marks: [{ selector: '#buy' }, { box: { x: 1, y: 2, w: 3, h: 4 } }] };
  const n = issueWith(`x\n\n<!-- papercut-place: ${encodeURIComponent(JSON.stringify(place))} -->\n`);
  const r = await cliEnv({ PATH: '/nonexistent' }, 'replay', String(n));
  assert.match(r.out, /marks: 1 #buy, 2 box 3x4 at 1,2/);
});

test('the package ships replay and the schema', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const dir of ['bin', 'src', 'widget', 'replay', 'schema', 'skills', 'AGENTS.md']) assert.ok(pkg.files.includes(dir), dir);
});

test('config --file checks a local file offline', async () => {
  const f = join(cwd, 'p.json');
  writeFileSync(f, JSON.stringify({ fields: [{ id: 'expected', label: 'Expected?' }] }));
  const n = gh.state.requests.length;
  let r = await cli('config', '--file', f);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^config: .*p\.json \(local file\)$/m);
  assert.equal(gh.state.requests.length, n);
  writeFileSync(f, '{ broken');
  r = await cli('config', '--file', f, '--check');
  assert.equal(r.code, 1);
  assert.match(r.out, /not valid JSON/);
  r = await cli('config', '--file', join(cwd, 'missing.json'));
  assert.equal(r.code, 1);
  assert.match(r.out, /^error: cannot read/m);
});

test('init prints code for the stack, checks the config, and explains the integration', async () => {
  const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs');
  const dir = mk(join(tmpdir(), 'pc-init2-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Tim-Conrad/shop.git'], { cwd: dir });
  md(join(dir, 'frontend'));
  writeFileSync(join(dir, 'frontend', 'package.json'), '{"devDependencies":{"vite":"6"}}');
  let out = '';
  const code = await run(['init'], { env: { HOME: home }, cwd: dir, client, stdout: { write: (s) => { out += s; } } });
  assert.equal(code, 0, out);
  assert.match(out, /^stack: vite$/m);
  assert.match(out, /^snippet\[\d+\]:/m);
  assert.match(out, /^check: \.github\/papercuts\.json has no warnings$/m);
  assert.match(out, /github\.com\/Tim-Conrad\/papercuts#integrate-papercuts-into-an-app/);
  const cfg = JSON.parse(readFileSync(join(dir, '.github', 'papercuts.json'), 'utf8'));
  assert.equal(cfg.fields.length, 1);
  assert.equal(cfg.fields[0].required, false);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  for (const s of ['.github/papercuts.json', 'papercutsContext', 'PAPERCUTS_URL', 'papercuts config']) assert.ok(agents.includes(s), s);
});

test('init prints the FastAPI code that avoids the 304 trap', async () => {
  writeFileSync(join(cwd, 'requirements.txt'), 'fastapi\n');
  const r = await cli('init');
  assert.match(r.out, /HTMLResponse/);
});

test('init replaces an outdated papercuts block and keeps the rest of AGENTS.md (papercut #16)', async () => {
  writeFileSync(join(cwd, 'AGENTS.md'), '# Agents\n\nIntro.\n\n## Papercuts\n\nReport friction with papercuts. Old text without the integration part.\n\n## Deploy\n\nRun deploy.\n');
  const r = await cli('init');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^AGENTS\.md: updated the papercuts block$/m);
  const text = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.ok(!text.includes('Old text'), text);
  assert.ok(text.includes('### Integration'));
  assert.match(text, /^Intro\.$/m);
  assert.match(text, /## Deploy\n\nRun deploy\.\n$/);
  assert.equal((text.match(/^## Papercuts$/gm) || []).length, 1);
  const again = await cli('init');
  assert.match(again.out, /^AGENTS\.md: has the current papercuts block, not changed$/m);
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), text);
});

test('comment adds a comment to the issue, with secrets redacted', async () => {
  await cli('add', 'rule', 'Two rules disagree');
  const r = await cli('comment', '1', 'Option A or B, token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^papercut: comment added to #1$/m);
  const body = gh.state.issues['Tim-Conrad/shop'][0].commentList.at(-1);
  assert.match(body, /^Option A or B/);
  assert.ok(!body.includes('ghp_abcdefghij'), body);
});

test('init finds FastAPI in app/ and prints the Jinja template code for server-rendered pages (papercut #19)', async () => {
  mkdirSync(join(cwd, 'app', 'templates'), { recursive: true });
  writeFileSync(join(cwd, 'app', 'requirements.txt'), 'fastapi\njinja2\n');
  writeFileSync(join(cwd, 'app', 'templates', 'base.html'), '<html><head></head></html>');
  const r = await cli('init');
  assert.match(r.out, /^stack: fastapi-jinja$/m);
  assert.match(r.out, /\{% if papercuts_url\(\) %\}<script src="\{\{ papercuts_url\(\) \}\}\/papercuts\.js" data-repo="Tim-Conrad\/shop"><\/script>\{% endif %\}/);
  assert.match(r.out, /base\.html/);
});

test('init finds a FastAPI app in any first-level folder before an nginx.conf at the top (papercut #20)', async () => {
  writeFileSync(join(cwd, 'nginx.conf'), 'server {}');
  mkdirSync(join(cwd, 'admin'));
  writeFileSync(join(cwd, 'admin', 'requirements.txt'), 'fastapi\nuvicorn\n');
  const r = await cli('init');
  assert.match(r.out, /^stack: fastapi$/m);
});

test('the starter config sets no kinds, so that agent kinds like tool stay allowed', async () => {
  await cli('init');
  const cfg = JSON.parse(readFileSync(join(cwd, '.github', 'papercuts.json'), 'utf8'));
  assert.equal(cfg.kinds, undefined);
});
