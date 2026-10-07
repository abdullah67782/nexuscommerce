#!/usr/bin/env node
/**
 * graphify — regenerates the AUTO section of ARCHITECTURE.md by scanning the source.
 *
 *   node tools/graphify.js           # rewrite the AUTO block in ARCHITECTURE.md
 *   node tools/graphify.js --print   # print it to stdout instead
 *
 * Only the mechanical facts are generated here (file inventory, route tables, ML endpoints,
 * DB tables, model files, frontend -> API call graph). The prose sections above the AUTO
 * marker are hand-written and must be updated by a human (or an agent) when behaviour changes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'ARCHITECTURE.md');
const BEGIN = '<!-- BEGIN:AUTO';
const END = '<!-- END:AUTO -->';
const SKIP_DIRS = new Set(['node_modules', '.next', '__pycache__', 'venv', '.git', 'uploads', 'models', 'data']);
const SRC_EXT = new Set(['.js', '.jsx', '.mjs', '.py', '.css']);

// ─── file walking ─────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (SRC_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').length;
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

// ─── extractors ───────────────────────────────────────────────────────────────

/** Express routes, resolved against the mount prefixes declared in server.js. */
function expressRoutes() {
  const server = read(path.join(ROOT, 'backend', 'server.js'));
  const mounts = {}; // router variable name -> mount path
  for (const m of server.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) {
    mounts[m[2]] = m[1];
  }
  // map router variable -> the file it was required from
  const fileFor = {};
  for (const m of server.matchAll(/(?:const|let)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\(['"]\.\/(routes\/[\w-]+)['"]\)/g)) {
    const file = m[3] + '.js';
    if (m[1]) fileFor[m[1]] = { file, exportName: null };
    else {
      for (const part of m[2].split(',')) {
        const [orig, alias] = part.split(':').map((s) => s.trim());
        fileFor[alias || orig] = { file, exportName: orig };
      }
    }
  }

  const rows = [];
  for (const [varName, mount] of Object.entries(mounts)) {
    const info = fileFor[varName];
    if (!info) continue;
    const src = read(path.join(ROOT, 'backend', info.file));
    // routers defined in the file: `const x = express.Router()`
    const routerVars = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*express\.Router\(\)/g)].map((m) => m[1]);
    // which local router variable does this mount correspond to?
    let target = info.exportName;
    if (!target) target = routerVars.includes('router') ? 'router' : routerVars[0];

    const pattern = new RegExp(`^\\s*${target}\\.(get|post|put|patch|delete)\\(\\s*['"\`]([^'"\`]+)['"\`]([^)]*)`, 'gm');
    const fileLines = src.split('\n');
    for (const m of src.matchAll(pattern)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      const full = (mount + (m[2] === '/' ? '' : m[2])).replace(/\/{2,}/g, '/');
      const auth = /authMiddleware/.test(m[3] || fileLines[lineNo - 1] || '') ? 'yes' : '—';
      rows.push({ method: m[1].toUpperCase(), route: full, auth, loc: `${info.file}:${lineNo}` });
    }
  }
  return rows.sort((a, b) => a.route.localeCompare(b.route));
}

/** FastAPI endpoints from ml/*.py */
function fastapiRoutes() {
  const rows = [];
  for (const file of fs.existsSync(path.join(ROOT, 'ml')) ? fs.readdirSync(path.join(ROOT, 'ml')) : []) {
    if (!file.endsWith('.py')) continue;
    const src = read(path.join(ROOT, 'ml', file));
    for (const m of src.matchAll(/@app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["'][\s\S]*?\ndef\s+(\w+)/g)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      rows.push({ method: m[1].toUpperCase(), route: m[2], fn: m[3], loc: `ml/${file}:${lineNo}` });
    }
  }
  return rows;
}

/** Which frontend file calls which backend endpoint. */
function frontendCalls() {
  const dir = path.join(ROOT, 'frontend', 'src');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of walk(dir)) {
    const src = read(file);
    for (const m of src.matchAll(/api\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      rows.push({ method: m[1].toUpperCase(), route: '/api' + m[2], loc: `${rel(file)}:${lineNo}` });
    }
  }
  return rows;
}

/** Tables + their columns from config/initDb.js */
function dbTables() {
  const src = read(path.join(ROOT, 'backend', 'config', 'initDb.js'));
  const tables = [];
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g)) {
    const cols = m[2]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0].replace(/,$/, ''))
      .filter((c) => !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)$/i.test(c));
    tables.push({ name: m[1], cols });
  }
  const added = [...src.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/g)]
    .map((m) => `${m[1]}.${m[2]}`);
  return { tables, added };
}

function modelFiles() {
  const dir = path.join(ROOT, 'ml', 'models');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.pkl')).sort();
}

// ─── rendering ────────────────────────────────────────────────────────────────

function render() {
  const out = [];
  const p = (s = '') => out.push(s);

  p('## 10. AUTO — file inventory');
  p();
  p(`_Generated ${new Date().toISOString().slice(0, 10)} by \`tools/graphify.js\`._`);
  p();
  const files = walk(ROOT).sort((a, b) => lines(b) - lines(a));
  const total = files.reduce((s, f) => s + lines(f), 0);
  p(`${files.length} source files, ${total} lines total.`);
  p();
  p('| File | Lines |');
  p('|---|---|');
  for (const f of files) p(`| \`${rel(f)}\` | ${lines(f)} |`);
  p();

  p('## 11. AUTO — backend API surface');
  p();
  p('| Method | Route | Auth | Defined in |');
  p('|---|---|---|---|');
  for (const r of expressRoutes()) p(`| ${r.method} | \`${r.route}\` | ${r.auth} | \`${r.loc}\` |`);
  p();

  p('## 12. AUTO — ML server endpoints');
  p();
  p('| Method | Route | Function | Defined in |');
  p('|---|---|---|---|');
  for (const r of fastapiRoutes()) p(`| ${r.method} | \`${r.route}\` | \`${r.fn}()\` | \`${r.loc}\` |`);
  p();

  p('## 13. AUTO — frontend → API call graph');
  p();
  p('| Caller | Method | Endpoint |');
  p('|---|---|---|');
  for (const r of frontendCalls()) p(`| \`${r.loc}\` | ${r.method} | \`${r.route}\` |`);
  p();

  p('## 14. AUTO — database tables');
  p();
  const { tables, added } = dbTables();
  for (const t of tables) p(`- **${t.name}** — ${t.cols.join(', ')}`);
  if (added.length) {
    p();
    p(`Columns added later via ALTER: ${added.map((a) => `\`${a}\``).join(', ')}`);
  }
  p();

  p('## 15. AUTO — trained model artefacts');
  p();
  const models = modelFiles();
  p(models.length ? models.map((m) => `\`${m}\``).join(' · ') : '_none — run ml/train_models.py_');
  p();

  return out.join('\n');
}

// ─── main ─────────────────────────────────────────────────────────────────────

const body = render();

if (process.argv.includes('--print')) {
  console.log(body);
  process.exit(0);
}

const doc = read(DOC);
const beginIdx = doc.indexOf(BEGIN);
const endIdx = doc.indexOf(END);
if (beginIdx === -1 || endIdx === -1) {
  console.error(`Could not find the AUTO markers in ${DOC}. Aborting without writing.`);
  process.exit(1);
}
const beginLineEnd = doc.indexOf('\n', beginIdx);
const updated = doc.slice(0, beginLineEnd + 1) + '\n' + body + '\n' + doc.slice(endIdx);
fs.writeFileSync(DOC, updated);
console.log(`ARCHITECTURE.md AUTO section regenerated (${body.split('\n').length} lines).`);
