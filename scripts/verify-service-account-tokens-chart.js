#!/usr/bin/env node
// The agent-provisioner service account can read and write every Secret in its
// namespace, create Deployments and exec into pods. Only the workloads that
// provision agents need that: the web backend, its worker and ops-runner. Any
// other workload the chart runs as that account must not mount its token, or a
// compromise of that process reaches every Secret in the namespace (F533).
// Pods the backend creates at runtime (agent gateways) are checked by
// backend/__tests__/unit/services/gatewayProvisionerServiceK8s.serviceAccount.test.js.
// Renders the chart itself:
//   node scripts/verify-service-account-tokens-chart.js
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const chart = 'k8s/helm/commonly';
const lanes = {
  default: [`${chart}/values.yaml`],
  dev: [`${chart}/values.yaml`, `${chart}/values-dev.yaml`],
  // What deploy-staging.yml renders: no values-dev.yaml.
  staging: [`${chart}/values.yaml`, `${chart}/values-staging.yaml`],
};
// Each lane also renders with the optional workloads on, so a workload that
// ships disabled is still checked.
const extraSets = [
  'backend.worker.enabled=true',
  'backend.worker.startPaused=false',
  'agents.commonlyBot.enabled=true',
];
const PROVISIONER = 'agent-provisioner';
const NEEDS_TOKEN = new Set(['backend', 'backend-worker', 'ops-runner']);

const render = (lane) => {
  const args = ['template', `commonly-${lane}`, chart];
  for (const f of lanes[lane]) args.push('-f', f);
  for (const s of extraSets) args.push('--set', s);
  return yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).filter(Boolean);
};

const podSpecOf = (doc) => {
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(doc.kind)) return doc.spec?.template?.spec;
  if (doc.kind === 'CronJob') return doc.spec?.jobTemplate?.spec?.template?.spec;
  return null;
};

const failures = [];
let checked = 0;
for (const lane of Object.keys(lanes)) {
  const docs = render(lane);
  const accounts = new Map(docs.filter((d) => d.kind === 'ServiceAccount').map((d) => [d.metadata.name, d]));
  for (const doc of docs) {
    const spec = podSpecOf(doc);
    if (!spec) continue;
    const account = spec.serviceAccountName || spec.serviceAccount || 'default';
    if (account !== PROVISIONER) continue;
    checked += 1;
    const name = doc.metadata.name;
    if (NEEDS_TOKEN.has(name)) continue;
    const mounts = spec.automountServiceAccountToken ?? accounts.get(account)?.automountServiceAccountToken ?? true;
    if (mounts !== false) {
      failures.push(`${lane}: ${doc.kind}/${name} runs as ${PROVISIONER} and mounts its token; set automountServiceAccountToken: false or give it its own account`);
    }
  }
}

if (!checked) failures.push(`no workload rendered as ${PROVISIONER}; the check is not reading the chart`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`ok: ${checked} workload renders as ${PROVISIONER}; only ${[...NEEDS_TOKEN].join(', ')} mount its token`);
