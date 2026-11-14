import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { credentialFrom } from '../src/credential.js';
import { githubClient } from '../src/github.js';

test('github host: github.com by default, with the public API hosts', () => {
  const c = loadConfig({});
  assert.deepEqual(c.github, {
    host: 'github.com',
    apiBase: 'https://api.github.com',
    uploadBase: 'https://uploads.github.com',
    assetHosts: ['github.com'],
  });
  assert.deepEqual(c.credential, { source: 'gh' });
});

test('PAPERCUTS_GITHUB_HOST: Enterprise-style URLs on that host, and gh asked for it', () => {
  const c = loadConfig({ PAPERCUTS_GITHUB_HOST: 'gh.gate', PAPERCUTS_GH_MOUNT: '/gh' });
  assert.deepEqual(c.github, {
    host: 'gh.gate',
    apiBase: 'https://gh.gate/api/v3',
    uploadBase: 'https://gh.gate/api/uploads',
    assetHosts: ['gh.gate'],
  });
  assert.deepEqual(c.credential, { source: 'gh', mount: '/gh', host: 'gh.gate' });
  // The file credential needs no host: the token goes wherever the client sends it.
  assert.deepEqual(loadConfig({ PAPERCUTS_GITHUB_HOST: 'gh.gate', PAPERCUTS_TOKEN_FILE: '/t' }).credential, { source: 'file', path: '/t' });
});

test('PAPERCUTS_GITHUB_HOST must be a bare host name', () => {
  for (const bad of ['https://gh.gate', 'gh.gate/api', 'gh gate', '']) {
    assert.throws(() => loadConfig({ PAPERCUTS_GITHUB_HOST: bad }), /PAPERCUTS_GITHUB_HOST/, bad);
  }
});

test('gh credential with a host passes GH_HOST to gh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-host-'));
  const fake = join(dir, 'gh');
  writeFileSync(fake, '#!/bin/sh\necho "fake-$GH_HOST"\n');
  chmodSync(fake, 0o755);
  const cred = credentialFrom({ source: 'gh', gh: fake, host: 'gh.gate', env: { ...process.env, GH_HOST: '' } });
  assert.equal(await cred.token(), 'fake-gh.gate');
});

test('download: a github.com picture is fetched through the configured host', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push([String(url), opts.headers.authorization]);
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const client = githubClient({
    credential: { token: async () => 'dummy' },
    apiBase: 'https://gh.gate/api/v3',
    uploadBase: 'https://gh.gate/api/uploads',
    assetHosts: ['gh.gate'],
    fetchImpl,
  });
  const buf = await client.download('https://github.com/user-attachments/assets/abc');
  assert.deepEqual([...buf], [1, 2, 3]);
  assert.deepEqual(seen, [['https://gh.gate/user-attachments/assets/abc', 'Bearer dummy']]);
  await assert.rejects(client.download('https://evil.example/x.png'), /papercuts sends the token only to gh.gate/);
});

test('repoFromGit: the repo stays github.com when git rewrites the URL (url.<base>.insteadOf)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { repoFromGit } = await import('../src/repo.js');
  const dir = mkdtempSync(join(tmpdir(), 'pc-insteadof-'));
  const cfg = join(dir, 'gitconfig');
  writeFileSync(cfg, '[url "https://gh.gate/"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = https://github.com/\n');
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Tim-Conrad/shop.git'], { cwd: repo });
  const old = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    assert.equal(repoFromGit(repo), 'Tim-Conrad/shop');
  } finally {
    if (old === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = old;
  }
});
