#!/usr/bin/env node
/**
 * Break one load-bearing rule at a time, run the conformance suite, and record
 * which tests fail; then restore the file from a copy and confirm it matches.
 * A mutation that no test catches is reported as SURVIVED.
 *
 * Usage: node bench/mutation-check.js [ts|go]   (Go needs `go` on PATH)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  { impl: 'ts', rule: 'tools/list filters to the grant', file: 'ts/broker.js',
    find: '.filter((t) => grant.tools.has(t.name))', replace: '' },
  { impl: 'ts', rule: 'ungranted tool is refused', file: 'ts/broker.js',
    find: "if (!grant.tools.has(tool)) throw refuse(grant, tool, digest, 'not_granted');", replace: '' },
  { impl: 'ts', rule: 'credential is redacted from upstream bodies', file: 'ts/broker.js',
    find: "text.split(credential).join('[redacted]')", replace: 'text' },
  { impl: 'ts', rule: 'maxCalls slot reserved before the approval await', file: 'ts/broker.js',
    find: 'grant.used += 1;', replace: '' },
  { impl: 'ts', rule: 'maxCalls reservation happens before any await (concurrency)', file: 'ts/broker.js',
    find: 'grant.used += 1;', replace: '',
    also: [{ find: "return upstream('tools/call', { name: tool, arguments: args });",
      replace: "const out = await upstream('tools/call', { name: tool, arguments: args }); grant.used += 1; return out;" }] },
  { impl: 'ts', rule: 'approval timeout denies', file: 'ts/broker.js',
    find: "pending.delete(id); resolve('timeout');", replace: "pending.delete(id); resolve('allow');" },
  { impl: 'ts', rule: 'audit file tightened to 0600', file: 'ts/broker.js',
    find: 'fchmodSync(fd, 0o600);', replace: '' },
  { impl: 'go', rule: 'tools/list filters to the grant', file: 'go/mcp.go',
    find: 'json.Unmarshal(t, &named) == nil && g.tools[named.Name]', replace: 'json.Unmarshal(t, &named) == nil' },
  { impl: 'go', rule: 'ungranted tool is refused', file: 'go/grants.go',
    find: '\tif !g.tools[tool] {\n\t\treturn "not_granted"\n\t}\n', replace: '' },
  { impl: 'go', rule: 'credential is redacted from upstream bodies', file: 'go/mcp.go',
    find: 'text = bytes.ReplaceAll(text, []byte(u.credential), []byte("[redacted]"))', replace: '' },
  { impl: 'go', rule: 'maxCalls slot reserved in admit', file: 'go/grants.go',
    find: '\tg.used++\n', replace: '' },
  { impl: 'go', rule: 'approval timeout denies', file: 'go/grants.go',
    find: '\t\tif removed {\n\t\t\treturn "timeout"', replace: '\t\tif removed {\n\t\t\treturn "allow"' },
  { impl: 'go', rule: 'audit file tightened to 0600', file: 'go/audit.go',
    find: '\tif err := f.Chmod(0o600); err != nil {\n\t\tf.Close()\n\t\treturn nil, err\n\t}\n', replace: '' },
];

const buildGo = () => {
  const r = spawnSync('go', ['build', '-o', 'broker', '.'], { cwd: join(ROOT, 'go'), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go build failed: ${r.stderr}`);
};

const runSuite = (impl) => {
  const r = spawnSync(process.execPath, ['--test', 'conformance/broker.test.js'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, BROKER: impl }, timeout: 180_000,
  });
  const out = r.stdout + r.stderr;
  const failed = [...new Set([...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((m) => m[1]))]
    .filter((name) => !/^(protocol|grant scope|approval|expiry and maxCalls|audit log)$/.test(name));
  return { status: r.status, failed, pass: Number(/ℹ pass (\d+)/.exec(out)?.[1]), fail: Number(/ℹ fail (\d+)/.exec(out)?.[1]) };
};

const only = process.argv[2];
const ruleFilter = process.argv[3]; // optional substring of a rule name
const results = [];
for (const m of MUTATIONS.filter((x) => (!only || x.impl === only) && (!ruleFilter || x.rule.includes(ruleFilter)))) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const steps = [{ find: m.find, replace: m.replace }, ...(m.also || [])];
  for (const s of steps) {
    if (original.split(s.find).length !== 2) throw new Error(`mutation anchor not found exactly once: ${m.rule} in ${m.file}`);
  }
  copyFileSync(path, `${path}.orig`);
  try {
    writeFileSync(path, steps.reduce((text, s) => text.replace(s.find, s.replace), original));
    if (m.impl === 'go') buildGo();
    const r = runSuite(m.impl);
    results.push({ ...m, ...r });
    console.log(`${r.status !== 0 || r.failed.length ? 'KILLED  ' : 'SURVIVED'} [${m.impl}] ${m.rule}: ${r.fail} failing -> ${r.failed.join(' | ')}`);
  } finally {
    copyFileSync(`${path}.orig`, path);
    spawnSync('rm', ['-f', `${path}.orig`]);
    if (readFileSync(path, 'utf8') !== original) throw new Error(`restore failed for ${m.file}`);
    if (m.impl === 'go') buildGo();
  }
}
const baseline = [...new Set(results.map((r) => r.impl))].map((impl) => ({ impl, ...runSuite(impl) }));
for (const b of baseline) console.log(`restored baseline [${b.impl}]: pass ${b.pass}, fail ${b.fail}`);
