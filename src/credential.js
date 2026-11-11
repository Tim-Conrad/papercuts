// Where the GitHub token comes from. The token never goes into argv, a log or an error.
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function credentialFrom(config = { source: 'gh' }) {
  if (config.source === 'file') {
    return {
      describe: () => `token file ${config.path}`,
      token: async () => {
        const text = (await readFile(config.path, 'utf8')).trim();
        if (!text) throw new Error(`token file ${config.path} is empty`);
        return text;
      },
    };
  }
  if (config.source === 'broker') {
    return {
      describe: () => `broker socket ${config.socket}`,
      token: async () => { throw new Error('the broker credential source is not implemented in v0.1'); },
    };
  }
  const bin = config.gh || 'gh';
  // A read-only mount of the host login (the relay container). gh may migrate its config and then writes it,
  // so gh gets a fresh private copy before each call. A gh auth refresh on the host reaches the next call.
  let copyDir;
  async function configDir() {
    copyDir ??= await mkdtemp(join(tmpdir(), 'papercuts-gh-'));
    for (const name of ['config.yml', 'hosts.yml']) {
      const to = join(copyDir, name);
      try { await copyFile(join(config.mount, name), to); await chmod(to, 0o600); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return copyDir;
  }
  return {
    describe: () => (config.mount ? `gh login (mounted from ${config.mount})` : 'gh login (gh auth token)'),
    token: async () => {
      const env = { ...(config.env || process.env) };
      if (config.mount) env.GH_CONFIG_DIR = await configDir();
      return ghToken(bin, env);
    },
  };
}

function ghToken(bin, env) {
  return new Promise((resolve, reject) => {
    // GH_CONFIG_DIR in env points gh at a login folder other than ~/.config/gh.
    execFile(bin, ['auth', 'token'], { timeout: 10000, env }, (err, stdout) => {
      const text = String(stdout || '').trim();
      if (err || !text) return reject(new Error('gh has no login: run `gh auth login`'));
      resolve(text);
    });
  });
}
