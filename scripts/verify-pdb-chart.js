#!/usr/bin/env node
// Every PodDisruptionBudget the chart renders must select the pods of exactly
// one workload in its own namespace: none guards nothing, and two or more ties
// their evictions together. No pod may sit under two PDBs, which makes the
// eviction API refuse it outright and blocks every drain of its node. None may
// use minAvailable, which holds a one-replica drain until GKE's timeout.
// frontend and cloudflared must each have one, plus a hostname spread that
// selects their own pods. Renders the chart itself:
//   node scripts/verify-pdb-chart.js
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const chart = 'k8s/helm/commonly';
const lanes = {
  default: [`${chart}/values.yaml`],
  dev: [`${chart}/values.yaml`, `${chart}/values-dev.yaml`],
  // What deploy-staging.yml renders: no values-dev.yaml.
  staging: [`${chart}/values.yaml`, `${chart}/values-staging.yaml`],
};
const GUARDED = ['frontend', 'cloudflared-commonly-k8s'];

const render = (lane) => {
  const args = ['template', `commonly-${lane}`, chart];
  for (const f of lanes[lane]) args.push('-f', f);
  return yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).filter(Boolean);
};
// A full label selector: matchLabels plus matchExpressions. An empty selector
// selects nothing here, because a PDB with one would guard every pod.
const selects = (selector, labels) => {
  const ml = Object.entries(selector?.matchLabels || {});
  const me = selector?.matchExpressions || [];
  if (ml.length + me.length === 0) return false;
  const has = (k) => Object.prototype.hasOwnProperty.call(labels || {}, k);
  const exprOk = ({ key, operator, values = [] }) => ({
    In: () => has(key) && values.includes(labels[key]),
    NotIn: () => !has(key) || !values.includes(labels[key]),
    Exists: () => has(key),
    DoesNotExist: () => !has(key),
  }[operator] || (() => { throw new Error(`unknown selector operator ${operator}`); }))();
  return ml.every(([k, v]) => labels?.[k] === v) && me.every(exprOk);
};

const failures = [];
const expect = (cond, msg) => { if (!cond) failures.push(msg); };

for (const lane of Object.keys(lanes)) {
  const docs = render(lane);
  const workloads = docs.filter((d) => ['Deployment', 'StatefulSet'].includes(d.kind));
  const pdbs = docs.filter((d) => d.kind === 'PodDisruptionBudget');
  for (const pdb of pdbs) {
    const ns = pdb.metadata.namespace;
    const hit = workloads.filter((w) => w.metadata.namespace === ns
      && selects(pdb.spec.selector, w.spec.template.metadata.labels));
    expect(hit.length === 1, `${lane}: PDB ${ns}/${pdb.metadata.name} selects ${hit.length} workloads' pods (${hit.map((w) => w.metadata.name).join(', ')}), want 1`);
    expect(pdb.spec.minAvailable === undefined, `${lane}: PDB ${ns}/${pdb.metadata.name} uses minAvailable`);
  }
  for (const w of workloads) {
    const over = pdbs.filter((p) => p.metadata.namespace === w.metadata.namespace
      && selects(p.spec.selector, w.spec.template.metadata.labels));
    expect(over.length <= 1, `${lane}: ${w.metadata.name}'s pods sit under ${over.length} PDBs (${over.map((p) => p.metadata.name).join(', ')})`);
  }
  for (const name of GUARDED) {
    const w = workloads.find((x) => x.kind === 'Deployment' && x.metadata.name === name);
    if (!w) continue;
    const labels = w.spec.template.metadata.labels;
    const pdb = pdbs.find((p) => p.metadata.namespace === w.metadata.namespace && selects(p.spec.selector, labels));
    expect(pdb && pdb.spec.maxUnavailable === 1, `${lane}: ${name} has no maxUnavailable-1 PDB`);
    const spread = (w.spec.template.spec.topologySpreadConstraints || [])
      .find((t) => t.topologyKey === 'kubernetes.io/hostname' && selects(t.labelSelector, labels));
    expect(spread && spread.whenUnsatisfiable === 'ScheduleAnyway', `${lane}: ${name} has no soft hostname spread over its own pods`);
  }
  // The positive control: dev, the lane that deploys, renders both.
  if (lane === 'dev') {
    for (const name of GUARDED) expect(workloads.some((x) => x.metadata.name === name), `${lane}: ${name} not rendered`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('verify-pdb-chart: ok');
