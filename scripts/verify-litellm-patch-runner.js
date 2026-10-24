#!/usr/bin/env node
/**
 * Exercise LiteLLM's boot patch against the two package copies in its image.
 * In 2026-08 a patch hit only /app/litellm while the proxy imported from
 * site-packages, leaving the agent fleet dark for 79 hours. This guard runs
 * the real chart Python with a proxy and a shadow fixture, and cleans each up.
 * Set LITELLM_CHART to check a mutated chart.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const chart = process.env.LITELLM_CHART || path.join(root, 'k8s/helm/commonly/templates/agents/litellm-deployment.yaml');
const verbose = process.argv.includes('--verbose');
const assert = (ok, why) => { if (!ok) throw new Error(why); };

function runner() {
  const lines = fs.readFileSync(chart, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^\s*"\$PYBIN" -c "\s*$/.test(line));
  const end = lines.findIndex((line, i) => i > start && /^\s*" \|\| exit 1\s*$/.test(line));
  assert(start >= 0 && end > start, 'LiteLLM boot runner anchors are missing');
  const body = lines.slice(start + 1, end);
  const indents = body.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length);
  assert(indents.length > 0, 'LiteLLM boot runner is empty');
  const src = body.map((line) => line.slice(Math.min(...indents))).join('\n').replace(/\\"/g, '"');
  assert(src.includes('import litellm') && src.includes('proxy_target='), 'wrong LiteLLM block extracted');
  return src;
}

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-patch-guard-'));
  const f = { app: path.join(dir, 'app'), site: path.join(dir, 'site') };
  try {
    for (const tree of [f.app, f.site]) {
      fs.mkdirSync(path.join(tree, 'litellm'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'litellm', '__init__.py'), '');
    }
    return fn(f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(src, f) {
  const env = { ...process.env, PYTHONPATH: f.site, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.PYTHONSAFEPATH; // The negative control needs Python to import from CWD.
  const r = spawnSync('python3', ['-c', src], {
    cwd: f.app,
    env,
    encoding: 'utf8',
  });
  assert(!r.error && typeof r.stdout === 'string', `python3 unavailable: ${r.error?.message || 'no stdout'}`);
  if (verbose) process.stdout.write(`${r.stdout}${r.stderr}`);
  return r;
}

function patchInfo(src) {
  const cut = src.indexOf('proxy_target=');
  assert(cut >= 0, 'cannot inspect LiteLLM patch variables');
  return fixture((f) => {
    const probe = `${src.slice(0, cut)}\nimport json\nprint('__PATCH__' + json.dumps({k: globals()[k] for k in ('name','rel','marker','old')}))\n`;
    const r = run(probe, f);
    const line = r.stdout.split('\n').find((value) => value.startsWith('__PATCH__'));
    assert(r.status === 0 && line, `patch introspection failed: ${r.stderr}`);
    return JSON.parse(line.slice('__PATCH__'.length));
  });
}

const target = (f, tree, p) => path.join(f[tree], 'litellm', ...p.rel);
const marked = (f, tree, p) => fs.existsSync(target(f, tree, p))
  && fs.readFileSync(target(f, tree, p), 'utf8').includes(p.marker);
function seed(f, p, { missingProxy = false, drift = false } = {}) {
  for (const tree of ['app', 'site']) {
    if (tree === 'site' && missingProxy) continue;
    const file = target(f, tree, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, drift ? '# changed upstream\npass\n' : `# fixture\n${p.old}\n`);
  }
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push(false);
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function main() {
  console.log(`LiteLLM patch runner: ${path.relative(root, chart)}`);
  const src = runner();
  const p = patchInfo(src);
  assert(p.name === 'responses-input', `unexpected local patch: ${p.name}`);

  check('proxy copy receives and verifies the patch', () => fixture((f) => {
    seed(f, p);
    const r = run(src, f);
    assert(r.status === 0 && r.stdout.includes('EFFECT verified'), `patch failed: ${r.stdout}${r.stderr}`);
    assert(marked(f, 'site', p) && marked(f, 'app', p), 'one of the two copies was not patched');
  }));

  check('second run is idempotent', () => fixture((f) => {
    seed(f, p);
    assert(run(src, f).status === 0, 'first run failed');
    const before = fs.readFileSync(target(f, 'site', p), 'utf8');
    const second = run(src, f);
    assert(second.status === 0 && second.stdout.includes('already applied'), 're-run was not recognized');
    assert(fs.readFileSync(target(f, 'site', p), 'utf8') === before, 're-run changed source');
  }));

  check('shadow-only write cannot pass', () => fixture((f) => {
    seed(f, p, { missingProxy: true });
    const r = run(src, f);
    assert(r.status === 1 && r.stdout.includes('FATAL'), 'missing proxy copy did not stop boot');
    assert(!r.stdout.includes('EFFECT verified') && marked(f, 'app', p), 'shadow write was counted as effect');
  }));

  check('upstream anchor drift stops boot', () => fixture((f) => {
    seed(f, p, { drift: true });
    const r = run(src, f);
    assert(r.status === 1 && r.stdout.includes('pattern not found'), 'drift did not stop boot');
    assert(!marked(f, 'site', p), 'drift fixture acquired the marker');
  }));

  check('CWD strip blocks the historical false effect', () => fixture((f) => {
    const strip = "sys.path=[p for p in sys.path if p not in ('', cwd)]";
    assert(src.includes(strip), 'CWD strip is absent');
    seed(f, p);
    const broken = run(src.replace(strip, 'sys.path=sys.path'), f);
    assert(broken.status === 0 && broken.stdout.includes('EFFECT verified'),
      'negative control no longer reproduces the false effect');
    assert(!marked(f, 'site', p) && marked(f, 'app', p), 'negative control did not hit shadow only');
  }));

  const passed = results.filter(Boolean).length;
  console.log(`${passed}/${results.length} cases passed`);
  if (passed !== results.length) process.exit(1);
}

main();
