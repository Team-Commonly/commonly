// Entropy gate (docs/development/workflow.md): size budgets, TODO ids, LOC budgets, Go import
// boundaries, and the exceptions ratchet. Budgets live in entropy.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const cfg = JSON.parse(readFileSync('entropy.json', 'utf8'));
const errors = [];
const isGenerated = (f) => cfg.generated.some((g) => f === g || f.startsWith(g));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => /\.(ts|tsx|mjs|js|go)$/.test(f) && !isGenerated(f));

function tsFunctions(file, text) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const name = node.name?.getText(src)
        ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(src) : '<anonymous>');
      const start = src.getLineAndCharacterOfPosition(node.getStart(src)).line;
      const end = src.getLineAndCharacterOfPosition(node.getEnd()).line;
      out.push({ name, lines: end - start + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

// gofmt puts every top-level func's opening line and closing brace at column 0.
function goFunctions(text) {
  const out = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    const m = /^func (?:\([^)]*\) )?([A-Za-z0-9_]+)/.exec(line);
    if (m && !line.endsWith('}')) open = { name: m[1], start: i };
    else if (open && line === '}') { out.push({ name: open.name, lines: i - open.start + 1 }); open = null; }
  });
  return out;
}

const loc = Object.fromEntries(Object.keys(cfg.locBudget).map((k) => [k, 0]));
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').length;
  if (lines > cfg.maxFileLines && !cfg.exceptions.files[file]) errors.push(`${file}: ${lines} lines > ${cfg.maxFileLines}`);
  const fns = file.endsWith('.go') ? goFunctions(text) : tsFunctions(file, text);
  for (const fn of fns) {
    if (fn.lines > cfg.maxFunctionLines && !cfg.exceptions.functions[`${file}:${fn.name}`]) {
      errors.push(`${file}:${fn.name}: ${fn.lines} lines > ${cfg.maxFunctionLines}`);
    }
  }
  if (!cfg.markerScanSkip.includes(file)) text.split("\n").forEach((line, i) => {
    if (/\b(TODO|FIXME|XXX)\b/.test(line) && !/\b(TODO|FIXME|XXX)\((F\d+|TASK-\d+)\)/.test(line)) {
      errors.push(`${file}:${i + 1}: TODO needs a row id, e.g. TODO(F07)`);
    }
  });
  for (const [area, b] of Object.entries(cfg.locBudget)) if (b.paths.some((p) => file.startsWith(p))) loc[area] += lines;
}
for (const [area, b] of Object.entries(cfg.locBudget)) {
  console.log(`LOC ${area.padEnd(6)} ${String(loc[area]).padStart(5)} / ${b.max}`);
  if (loc[area] > b.max) errors.push(`LOC budget: ${area} ${loc[area]} > ${b.max}`);
}

if (files.some((f) => f.endsWith('.go'))) {
  const mod = execFileSync('go', ['list', '-m'], { encoding: 'utf8' }).trim();
  const pkgs = execFileSync('go', ['list', '-f', '{{.ImportPath}} {{join .Imports " "}}', './...'], { encoding: 'utf8' });
  for (const row of pkgs.trim().split('\n')) {
    const [pkg, ...imports] = row.split(' ').filter(Boolean);
    const rule = cfg.goImports[pkg.replace(`${mod}/`, '')];
    if (!rule) continue;
    for (const imp of imports) {
      const std = !imp.split('/')[0].includes('.');
      const ok = (std && rule.allow.includes('std')) || rule.allow.some((a) => imp === `${mod}/${a}`);
      if (!ok) errors.push(`import boundary: ${pkg} may not import ${imp}`);
    }
  }
}

// Ratchet: exceptions only shrink, unless the new one cites an ADR note.
try {
  const base = JSON.parse(execFileSync('git', ['show', 'origin/v4:entropy.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  for (const kind of ['files', 'functions']) {
    for (const [key, reason] of Object.entries(cfg.exceptions[kind])) {
      if (!(key in base.exceptions[kind]) && !reason.includes('docs/adr/')) errors.push(`new ${kind} exception ${key} must cite a docs/adr/ note`);
    }
  }
} catch { /* no entropy.json on origin/v4 yet */ }

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`entropy ok: ${files.length} files`);
