#!/usr/bin/env node
// The egress policies (templates/network/egress-restrict.yaml): pods may reach
// any address except exceptCidrs; pods whose component is in exemptComponents
// keep full egress (backup uses Workload Identity). With
// networkPolicy.egress.restrict on (the staging lane), both policies render in
// the release namespace: egress-restrict cuts exactly 169.254.169.254/32 for
// every pod but backup's (169.254.20.10 stays reachable), and
// egress-restrict-exempt gives the backup pods full egress. With it off (the
// default and dev lanes), neither renders. Staging runs no backups, so a
// staging+backup lane turns them on to check the selectors against real pods.
// Renders the chart itself:
//   node scripts/verify-network-policy-chart.js
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const chart = 'k8s/helm/commonly';
const lanes = {
  default: { files: [`${chart}/values.yaml`], on: false },
  dev: { files: [`${chart}/values.yaml`, `${chart}/values-dev.yaml`], on: false },
  staging: { files: [`${chart}/values.yaml`, `${chart}/values-staging.yaml`], on: true, backups: 0 },
  'staging+backup': {
    files: [`${chart}/values.yaml`, `${chart}/values-staging.yaml`],
    set: 'backup.mongodb.enabled=true,backup.postgresql.enabled=true',
    on: true,
    backups: 2,
  },
};

const render = (lane) => {
  const args = ['template', 'commonly-verify', chart];
  for (const f of lanes[lane].files) args.push('-f', f);
  if (lanes[lane].set) args.push('--set', lanes[lane].set);
  return yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).filter(Boolean);
};
// A NetworkPolicy podSelector: unlike a PDB's, an empty one selects every pod.
const selects = (selector, labels) => {
  const has = (k) => Object.prototype.hasOwnProperty.call(labels || {}, k);
  const exprOk = ({ key, operator, values = [] }) => ({
    In: () => has(key) && values.includes(labels[key]),
    NotIn: () => !has(key) || !values.includes(labels[key]),
    Exists: () => has(key),
    DoesNotExist: () => !has(key),
  }[operator] || (() => { throw new Error(`unknown selector operator ${operator}`); }))();
  return Object.entries(selector?.matchLabels || {}).every(([k, v]) => labels?.[k] === v)
    && (selector?.matchExpressions || []).every(exprOk);
};
const podTemplate = (d) => (d.kind === 'CronJob' ? d.spec.jobTemplate.spec.template : d.spec?.template);

const failures = [];
const expect = (cond, msg) => { if (!cond) failures.push(msg); };

for (const [lane, { on, backups: wantBackups }] of Object.entries(lanes)) {
  const docs = render(lane);
  const policies = docs.filter((d) => d.kind === 'NetworkPolicy');
  const restrict = policies.find((p) => p.metadata.name === 'egress-restrict');
  const exempt = policies.find((p) => p.metadata.name === 'egress-restrict-exempt');
  if (!on) {
    expect(!restrict && !exempt, `${lane}: egress policies render with the flag off`);
    continue;
  }
  expect(restrict && exempt, `${lane}: want both egress policies, got ${policies.map((p) => p.metadata.name).join(', ') || 'none'}`);
  if (!restrict || !exempt) continue;

  const workloads = docs.filter((d) => ['Deployment', 'StatefulSet', 'CronJob', 'Job'].includes(d.kind) && podTemplate(d));
  const ns = restrict.metadata.namespace;
  expect(exempt.metadata.namespace === ns, `${lane}: the two policies render into different namespaces`);
  expect(workloads.some((w) => w.metadata.namespace === ns), `${lane}: no workload renders into the policies' namespace ${ns}`);

  expect(JSON.stringify(restrict.spec.policyTypes) === '["Egress"]', `${lane}: egress-restrict policyTypes is not [Egress]`);
  const blocks = (restrict.spec.egress || []).flatMap((r) => r.to || []).map((t) => t.ipBlock).filter(Boolean);
  expect(restrict.spec.egress?.length === 1 && blocks.length === 1 && blocks[0].cidr === '0.0.0.0/0',
    `${lane}: egress-restrict is not one 0.0.0.0/0 ipBlock rule`);
  const except = blocks[0]?.except || [];
  expect(JSON.stringify(except) === '["169.254.169.254/32"]', `${lane}: except is ${JSON.stringify(except)}, want exactly 169.254.169.254/32`);
  expect(!except.some((c) => c.startsWith('169.254.20.')), `${lane}: except cuts 169.254.20.10 (node-local DNS)`);

  expect(JSON.stringify(exempt.spec.policyTypes) === '["Egress"]', `${lane}: egress-restrict-exempt policyTypes is not [Egress]`);
  expect(JSON.stringify(exempt.spec.egress) === '[{}]', `${lane}: egress-restrict-exempt does not allow all egress`);

  const inNs = workloads.filter((w) => w.metadata.namespace === ns);
  const backups = inNs.filter((w) => podTemplate(w).metadata?.labels?.component === 'backup');
  expect(backups.length === wantBackups, `${lane}: want ${wantBackups} backup CronJobs, found ${backups.length}`);
  for (const w of inNs) {
    const labels = podTemplate(w).metadata?.labels;
    const isBackup = labels?.component === 'backup';
    const inRestrict = selects(restrict.spec.podSelector, labels);
    const inExempt = selects(exempt.spec.podSelector, labels);
    if (isBackup) {
      expect(!inRestrict, `${lane}: egress-restrict selects backup pod ${w.metadata.name}`);
      expect(inExempt, `${lane}: egress-restrict-exempt misses backup pod ${w.metadata.name}`);
    } else {
      expect(inRestrict, `${lane}: egress-restrict misses ${w.kind} ${w.metadata.name}`);
      expect(!inExempt, `${lane}: egress-restrict-exempt selects non-backup ${w.kind} ${w.metadata.name}`);
    }
  }
  // Pods the backend creates at runtime carry no component label: restricted.
  expect(selects(restrict.spec.podSelector, { app: 'some-agent' }), `${lane}: egress-restrict misses an unlabelled pod`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('verify-network-policy-chart: ok');
