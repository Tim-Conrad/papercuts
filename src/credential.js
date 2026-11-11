// Where the GitHub token comes from. The token never goes into argv, a log or an error.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

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
  return {
    describe: () => 'gh login (gh auth token)',
    token: () => new Promise((resolve, reject) => {
      execFile(bin, ['auth', 'token'], { timeout: 10000 }, (err, stdout) => {
        const text = String(stdout || '').trim();
        if (err || !text) return reject(new Error('gh has no login: run `gh auth login`'));
        resolve(text);
      });
    }),
  };
}
