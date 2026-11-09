/**
 * Drift guard for the ops-runner env mirror.
 *
 * templates/ops/ops-runner-deployment.yaml mirrors the backend container's app
 * dependencies and volume mounts (it can't DRY-extract into a helper without changing
 * backend's byte-for-byte render — the env block has blank lines nindent would
 * re-indent). A "KEEP IN SYNC" banner alone drifts (recorded instances across
 * the chart), so this pins the contract: the two Deployments must declare the
 * SAME env entries except RUN_WORKER, which controls the serving process and
 * is not read by the sleeping ops-runner, and PG_USER/PG_PASSWORD: the backend
 * may connect as its own role (backend.env.pgAppUser), while ops-runner keeps
 * backend.env.pgUser for admin writes. Both exceptions are pinned exactly below.
 * Otherwise, the same (name, source) tuples,
 * where source is a
 * secretKeyRef name+key, a configMapKeyRef name+key, or a literal value. If
 * backend gains/loses an env var, or changes a var's source, and ops-runner
 * isn't updated to match, this fails.
 *
 * No helm render — the backend "Test & Coverage" jest job has no helm — so it
 * reads the raw templates the way hostedMcpClientWiring.test.js does. The raw
 * template has Helm conditionals (incl. if/else branches that repeat an env
 * NAME, e.g. FRONTEND_URL), so the comparison is a SORTED MULTISET of
 * `name<TAB>source` tuples: order-independent, but duplicates must match too.
 */
const fs = require('fs');
const path = require('path');
const { HELM_CHART } = require('../../utils/repoRoot');

const chart = HELM_CHART;

// Parse a Deployment template's MAIN container env block into an ARRAY of
// `name<TAB>source` tuples (duplicates kept — if/else branches repeat names).
// Anchors after `      - name: <container>` so backend's initContainer env is
// skipped; reads to `        volumeMounts:`. Helm conditionals/comments are
// ignored; the parser keys only on the env entries themselves.
function extractContainerEnv(tpl, containerName) {
  const lines = tpl.split('\n');
  const base = lines.indexOf(`      - name: ${containerName}`);
  if (base < 0) throw new Error(`container "${containerName}" not found`);
  let i = base;
  while (i < lines.length && lines[i] !== '        env:') i += 1;
  if (i >= lines.length) throw new Error(`env: not found for "${containerName}"`);
  i += 1;

  const tuples = [];
  let cur = null;
  let kind = null;
  let srcName = null;
  let srcKey = null;
  const flush = () => {
    if (!cur) return;
    let sig;
    if (kind === 'secret') sig = `secretKeyRef:${srcName}/${srcKey}`;
    else if (kind === 'configmap') sig = `configMapKeyRef:${srcName}/${srcKey}`;
    else if (kind === 'value') sig = cur.valueSig;
    else sig = 'UNKNOWN';
    tuples.push(`${cur.name}\t${sig}`);
    cur = null; kind = null; srcName = null; srcKey = null;
  };

  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (l === '        volumeMounts:') break;
    let m = l.match(/^ {8}- name: (.+)$/);
    if (m) { flush(); cur = { name: m[1].trim() }; continue; }
    if (!cur) continue; // comments / conditionals before the first entry
    m = l.match(/^ {10}value: (.*)$/);
    if (m) { kind = 'value'; cur.valueSig = `value:${m[1].trim()}`; continue; }
    if (/^ {12}secretKeyRef:\s*$/.test(l)) { kind = 'secret'; continue; }
    if (/^ {12}configMapKeyRef:\s*$/.test(l)) { kind = 'configmap'; continue; }
    if (kind === 'secret' || kind === 'configmap') {
      m = l.match(/^ {14}name: (.+)$/);
      if (m) { srcName = m[1].trim(); continue; }
      m = l.match(/^ {14}key: (.+)$/);
      if (m) { srcKey = m[1].trim(); continue; }
    }
  }
  flush();
  return tuples;
}

const backendTuples = extractContainerEnv(
  fs.readFileSync(path.join(chart, 'templates/core/backend-deployment.yaml'), 'utf8'),
  'backend',
);
const opsTuples = extractContainerEnv(
  fs.readFileSync(path.join(chart, 'templates/ops/ops-runner-deployment.yaml'), 'utf8'),
  'ops-runner',
);

if (typeof describe === 'function') {
  describe('ops-runner env mirrors backend env (drift guard)', () => {
    test('the parse is not vacuous (backend has a real env block)', () => {
      expect(backendTuples.length).toBeGreaterThan(40);
      expect(opsTuples.length).toBeGreaterThan(40);
    });

    // Sorted multiset: every (name, source) tuple in backend must appear in
    // ops-runner the same number of times, and vice versa. toEqual on the
    // sorted arrays reports exactly which env entry drifted.
    test('ops-runner declares the same env (name + source) tuples as backend', () => {
      const pgRole = (tuple) => /^PG_(USER|PASSWORD)\t/.test(tuple);
      const withoutWorkerGate = (tuple) => !tuple.startsWith('RUN_WORKER\t');
      const mirrored = (tuple) => withoutWorkerGate(tuple) && !pgRole(tuple);
      expect([...opsTuples].filter(mirrored).sort())
        .toEqual([...backendTuples].filter(mirrored).sort());
      expect(backendTuples.filter(pgRole).sort()).toEqual([
        'PG_PASSWORD\tsecretKeyRef:database-credentials/{{ .Values.backend.env.pgAppPasswordKey | default "postgres-password" | quote }}',
        'PG_USER\tvalue:{{ .Values.backend.env.pgAppUser | default .Values.backend.env.pgUser | default .Values.postgresql.username | quote }}',
      ]);
      expect(opsTuples.filter(pgRole).sort()).toEqual([
        'PG_PASSWORD\tsecretKeyRef:database-credentials/postgres-password',
        'PG_USER\tvalue:{{ .Values.backend.env.pgUser | default .Values.postgresql.username | quote }}',
      ]);
      expect(opsTuples.every(withoutWorkerGate)).toBe(true);
      expect(backendTuples.filter((tuple) => !withoutWorkerGate(tuple))).toEqual([
        'RUN_WORKER\tvalue:"1"',
        'RUN_WORKER\tvalue:"0"',
      ]);
    });
  });
}

module.exports = { extractContainerEnv, backendTuples, opsTuples };
