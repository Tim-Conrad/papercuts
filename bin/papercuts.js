#!/usr/bin/env node
// Answer the version before anything else loads (AXI fast path).
import { readFileSync } from 'node:fs';

const first = process.argv[2];
if (first === '-v' || first === '-V' || first === '--version') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(pkg.version + '\n');
  process.exit(0);
}
const { main } = await import('../src/cli.js');
process.exitCode = await main();
