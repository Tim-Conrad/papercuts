// papercuts init: set up papercuts in the repo of an app. It never overwrites a file.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH } from './ticket.js';

const AGENTS_SRC = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
const SCHEMA_URL = 'https://raw.githubusercontent.com/Tim-Conrad/papercuts/main/schema/papercuts.schema.json';

const read = (dir, f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };

export function detectStack(dir) {
  const py = read(dir, 'requirements.txt') + read(dir, 'pyproject.toml') + read(dir, 'backend/pyproject.toml') + read(dir, 'backend/requirements.txt');
  if (/fastapi/i.test(py)) return 'fastapi';
  const pkg = read(dir, 'package.json');
  if (/"vite"/.test(pkg)) return 'vite';
  if (/"express"/.test(pkg)) return 'express';
  if (existsSync(join(dir, 'nginx.conf')) || /^FROM\s+nginx/im.test(read(dir, 'Dockerfile'))) return 'nginx';
  if (existsSync(join(dir, 'index.html'))) return 'static';
  return 'unknown';
}

const STEPS = {
  fastapi: [
    'Serve index.html yourself when PAPERCUTS_URL is set: read the file and add the tag before </head>. Do not use FileResponse for it: its 304 keeps a cached copy without the tag.',
    'Leave every other file to StaticFiles.',
  ],
  vite: [
    'Add the tag when the server delivers index.html, not in the Vite build, so that one build works with and without papercuts.',
    'With a plain static server, use the nginx step in front of it.',
  ],
  express: ['In the route that sends index.html, add the tag before </head> when process.env.PAPERCUTS_URL is set.'],
  nginx: [
    'Put a template under /etc/nginx/templates/ with sub_filter \'</head>\' and the tag with ${PAPERCUTS_URL}; set sub_filter_once on.',
    'Keep two configs and let the entrypoint choose the one with the tag only when PAPERCUTS_URL is not empty.',
  ],
  static: ['Add the tag on the server that delivers the page, only when PAPERCUTS_URL is set. Do not write it into the HTML file.'],
  unknown: ['Find where the server delivers the HTML page, and add the tag there only when PAPERCUTS_URL is set.'],
};

export function starterConfig() {
  return {
    $schema: SCHEMA_URL,
    kinds: ['bug', 'ux', 'copy', 'idea', 'other'],
    fields: [],
    presets: [
      { kind: 'bug', text: 'This does not work' },
      { kind: 'ux', text: 'This is hard to use on the phone' },
      { kind: 'copy', text: 'This text is wrong or unclear' },
    ],
    labels: [],
  };
}

function agentsBlock() {
  const src = readFileSync(AGENTS_SRC, 'utf8');
  return src.split('```markdown\n')[1].split('\n```')[0];
}

export function initRepo(dir, repo, env = {}) {
  const stack = detectStack(dir);
  const out = { stack, repo: repo || 'unknown (no git remote "origin")' };

  const cfgFile = join(dir, CONFIG_PATH);
  if (existsSync(cfgFile)) out[CONFIG_PATH] = 'exists, not changed';
  else {
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(cfgFile, JSON.stringify(starterConfig(), null, 2) + '\n');
    out[CONFIG_PATH] = 'created (edit kinds, fields, presets, labels)';
  }

  const agents = join(dir, 'AGENTS.md');
  const text = read(dir, 'AGENTS.md');
  if (/^## Papercuts$/m.test(text)) out['AGENTS.md'] = 'has the papercuts block, not changed';
  else {
    writeFileSync(agents, (text ? `${text.replace(/\n*$/, '')}\n\n` : '# Agents\n\n') + agentsBlock() + '\n');
    out['AGENTS.md'] = text ? 'added the papercuts block' : 'created with the papercuts block';
  }

  const name = repo || 'owner/name';
  out.tag = `<script src="$PAPERCUTS_URL/papercuts.js" data-repo="${name}"></script>`;
  out.steps = [
    ...STEPS[stack],
    'Set PAPERCUTS_URL (for example https://papercuts.lab.example.com) only in the compose files of the lab and dev copies. A published copy has no PAPERCUTS_URL and so no tag.',
    'Add a test: without PAPERCUTS_URL the page has no "papercuts"; with it, the page has exactly one tag.',
    `Commit ${CONFIG_PATH} and AGENTS.md, then run \`papercuts config --check\` after the push.`,
  ];
  out.help = ['Run `papercuts config` to see the config that the relay uses', 'Read the README section "Integrate papercuts into an app"'];
  return out;
}
