import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { credentialFrom } from '../src/credential.js';

test('credential: gh by default, file with a token file, PAPERCUTS_CREDENTIAL decides', () => {
  assert.deepEqual(loadConfig({}).credential, { source: 'gh' });
  assert.deepEqual(loadConfig({ PAPERCUTS_TOKEN_FILE: '/t' }).credential, { source: 'file', path: '/t' });
  assert.deepEqual(loadConfig({ PAPERCUTS_TOKEN_FILE: '/t', PAPERCUTS_CREDENTIAL: 'gh' }).credential, { source: 'gh' });
  assert.throws(() => loadConfig({ PAPERCUTS_CREDENTIAL: 'file' }), /PAPERCUTS_TOKEN_FILE/);
  assert.throws(() => loadConfig({ PAPERCUTS_CREDENTIAL: 'app' }), /gh or file/);
});

test('gh credential passes GH_CONFIG_DIR to gh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gh-'));
  const fake = join(dir, 'gh');
  // A fake gh that answers with the config folder it got. It never sees a real token.
  writeFileSync(fake, '#!/bin/sh\necho "fake-$GH_CONFIG_DIR"\n');
  chmodSync(fake, 0o755);
  const cred = credentialFrom({ source: 'gh', gh: fake, env: { ...process.env, GH_CONFIG_DIR: '/gh' } });
  assert.equal(await cred.token(), 'fake-/gh');
});

test('gh mount: the login is copied to a private temp folder before each call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-ghm-'));
  const mount = join(dir, 'mount');
  const { mkdirSync, readFileSync, statSync } = await import('node:fs');
  mkdirSync(mount);
  writeFileSync(join(mount, 'hosts.yml'), 'github.com:\n  user: x\n');
  writeFileSync(join(mount, 'config.yml'), 'git_protocol: https\n');
  const fake = join(dir, 'gh');
  writeFileSync(fake, '#!/bin/sh\necho "$GH_CONFIG_DIR"\n');
  chmodSync(fake, 0o755);
  const cred = credentialFrom({ source: 'gh', gh: fake, mount, env: { ...process.env } });
  const used = await cred.token();
  assert.notEqual(used, mount);
  assert.equal(readFileSync(join(used, 'hosts.yml'), 'utf8'), 'github.com:\n  user: x\n');
  assert.equal(statSync(join(used, 'hosts.yml')).mode & 0o777, 0o600);
  writeFileSync(join(mount, 'hosts.yml'), 'github.com:\n  user: y\n');
  assert.equal(readFileSync(join(await cred.token(), 'hosts.yml'), 'utf8'), 'github.com:\n  user: y\n');
});

test('loadConfig passes PAPERCUTS_GH_MOUNT to the gh credential', () => {
  assert.deepEqual(loadConfig({ PAPERCUTS_GH_MOUNT: '/gh' }).credential, { source: 'gh', mount: '/gh' });
});
