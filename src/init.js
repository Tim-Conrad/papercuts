// papercuts init: set up papercuts in the repo of an app. It never overwrites a file.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, checkConfigText } from './ticket.js';
import { checkouts, localRepoName, readStoreSetting, STORE_DIR, DB_NAME } from './store.js';

const AGENTS_SRC = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
const SCHEMA_URL = 'https://raw.githubusercontent.com/Tim-Conrad/papercuts/main/schema/papercuts.schema.json';

const read = (dir, f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };

export function detectStack(dir) {
  const py = read(dir, 'requirements.txt') + read(dir, 'pyproject.toml') + read(dir, 'backend/pyproject.toml') + read(dir, 'backend/requirements.txt');
  if (/fastapi/i.test(py)) return 'fastapi';
  const pkg = read(dir, 'package.json') + read(dir, 'frontend/package.json') + read(dir, 'web/package.json');
  if (/"vite"/.test(pkg)) return 'vite';
  if (/"express"/.test(pkg)) return 'express';
  if (existsSync(join(dir, 'nginx.conf')) || /^FROM\s+nginx/im.test(read(dir, 'Dockerfile'))) return 'nginx';
  if (existsSync(join(dir, 'index.html'))) return 'static';
  return 'unknown';
}

const README = 'https://github.com/Tim-Conrad/papercuts#integrate-papercuts-into-an-app';

// Working code for each stack. REPO is replaced with the repo of the app.
const SNIPPETS = {
  fastapi: `import os
from fastapi.responses import HTMLResponse

@app.get("/")  # serve index.html yourself; a FileResponse 304 would keep a cached copy without the tag
def index():
    html = (STATIC_DIR / "index.html").read_text()
    if url := os.environ.get("PAPERCUTS_URL"):
        html = html.replace("</head>", f'<script src="{url}/papercuts.js" data-repo="REPO"></script></head>', 1)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})`,
  express: `app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const url = process.env.PAPERCUTS_URL;
  if (url) html = html.replace('</head>', \`<script src="\${url}/papercuts.js" data-repo="REPO"></script></head>\`);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});`,
  nginx: `# /etc/nginx/templates/papercuts.conf.template (the official image fills in \${PAPERCUTS_URL})
sub_filter '</head>' '<script src="\${PAPERCUTS_URL}/papercuts.js" data-repo="REPO"></script></head>';
sub_filter_once on;
# entrypoint: include this file only when PAPERCUTS_URL is not empty`,
};
SNIPPETS.vite = `# Add the tag where the server delivers the built index.html, not in the Vite build.
# With nginx in front:
${SNIPPETS.nginx}`;
SNIPPETS.static = SNIPPETS.nginx;
SNIPPETS.unknown = SNIPPETS.fastapi;

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
    fields: [
      { id: 'expected', label: 'What did you expect?', required: false },
    ],
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

const IGNORE = `${STORE_DIR}/`;

// Add .papercuts/ to the .gitignore of the checkout. The database must never go into git.
function ignoreStore(top) {
  const file = join(top, '.gitignore');
  const text = read(top, '.gitignore');
  if (text.split('\n').some((l) => [IGNORE, STORE_DIR, `/${IGNORE}`, `/${STORE_DIR}`].includes(l.trim()))) return `has ${IGNORE}, not changed`;
  writeFileSync(file, (text && !text.endsWith('\n') ? `${text}\n` : text) + `${IGNORE}\n`);
  return text ? `added ${IGNORE}` : `created with ${IGNORE}`;
}

export function initRepo(dir, repo, env = {}, { store: wanted } = {}) {
  const stack = detectStack(dir);
  const { top, main } = checkouts(dir);
  const cfgFile = join(dir, CONFIG_PATH);
  const store = wanted || readStoreSetting(dir) || 'github';
  if (!repo && store === 'local') repo = localRepoName(main);
  const out = { stack, repo: repo || 'unknown (no git remote "origin")' };

  if (!existsSync(cfgFile)) {
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(cfgFile, JSON.stringify({ ...starterConfig(), ...(store === 'local' ? { store } : {}) }, null, 2) + '\n');
    out[CONFIG_PATH] = 'created (edit kinds, fields, presets, labels)';
  } else if (wanted && readStoreSetting(dir) !== wanted && !(wanted === 'github' && !readStoreSetting(dir))) {
    // An explicit --store changes only that key. A broken file stays as it is, and the check below names the problem.
    try {
      const raw = JSON.parse(readFileSync(cfgFile, 'utf8'));
      writeFileSync(cfgFile, JSON.stringify({ ...raw, store: wanted }, null, 2) + '\n');
      out[CONFIG_PATH] = `set "store": "${wanted}"`;
    } catch {
      out[CONFIG_PATH] = 'is not valid JSON, not changed';
    }
  } else out[CONFIG_PATH] = 'exists, not changed';

  out.store = store === 'local'
    ? `local: ${STORE_DIR}/${DB_NAME} in ${main === dir ? 'this checkout' : main}, gitignored, no GitHub`
    : `github: each papercut is an issue in ${repo || 'the repo'}`;
  if (store === 'local') out['.gitignore'] = ignoreStore(top);

  const agents = join(dir, 'AGENTS.md');
  const text = read(dir, 'AGENTS.md');
  // The block ends at the next level-2 heading. An older papercuts version wrote a shorter block: replace it.
  const old = text.match(/^## Papercuts\n[\s\S]*?(?=^## |(?![\s\S]))/m);
  if (old) {
    const block = agentsBlock();
    const tail = old.index + old[0].length < text.length ? '\n\n' : '\n';
    if (old[0].replace(/\s+$/, '') === block) out['AGENTS.md'] = 'has the current papercuts block, not changed';
    else {
      writeFileSync(agents, text.slice(0, old.index) + block + tail + text.slice(old.index + old[0].length));
      out['AGENTS.md'] = 'updated the papercuts block';
    }
  } else {
    writeFileSync(agents, (text ? `${text.replace(/\n*$/, '')}\n\n` : '# Agents\n\n') + agentsBlock() + '\n');
    out['AGENTS.md'] = text ? 'added the papercuts block' : 'created with the papercuts block';
  }

  const name = repo || 'owner/name';
  out.tag = `<script src="$PAPERCUTS_URL/papercuts.js" data-repo="${name}"></script>`;
  out.snippet = SNIPPETS[stack].replaceAll('REPO', name).split('\n');
  const check = checkConfigText(read(dir, CONFIG_PATH));
  out.check = check.warnings.length ? `${CONFIG_PATH} has warnings` : `${CONFIG_PATH} has no warnings`;
  if (check.warnings.length) out.warnings = check.warnings;
  const relayStep = store === 'local'
    ? 'Start the local relay in this folder: `PORT=8787 papercuts serve`. Then set PAPERCUTS_URL=http://localhost:8787 for the dev server only. Reports from the page go to the local file.'
    : 'Set PAPERCUTS_URL (for example https://papercuts.lab.example.com) only in the compose files of the lab and dev copies. A published copy has no PAPERCUTS_URL and so no tag.';
  out.steps = [
    ...STEPS[stack],
    relayStep,
    'Add a test: without PAPERCUTS_URL the page has no "papercuts"; with it, the page has exactly one tag.',
    store === 'local' ? `Commit ${CONFIG_PATH}, AGENTS.md and .gitignore. Run \`papercuts doctor\` to check the local store.`
      : `Commit ${CONFIG_PATH} and AGENTS.md, then run \`papercuts config --check\` after the push.`,
  ];
  out.help = [`Run \`papercuts config --file ${CONFIG_PATH}\` after each change of the config`, `Read ${README}`];
  return out;
}
