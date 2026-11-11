// Pictures that GitHub did not take stay on the relay. One file per report id, nothing else.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function shotStore(dir) {
  return {
    save(id, buffer) {
      if (!NAME.test(id)) throw new Error('bad picture id');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${id}.png`);
      writeFileSync(path, buffer);
      return path;
    },
    read(id) {
      if (!NAME.test(id)) return null;
      try { return readFileSync(join(dir, `${id}.png`)); } catch { return null; }
    },
  };
}
