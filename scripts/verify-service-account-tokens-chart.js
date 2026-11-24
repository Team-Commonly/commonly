#!/usr/bin/env node
// The agent-provisioner service account can read and write every Secret in its
// namespace, create Deployments and exec into pods. Only the workloads that
// provision agents need that: the web backend and its worker. Any other
// workload the chart runs as that account must not mount its token, or a
// compromise of that process reaches every Secret in the namespace (F533).
// ops-runner is an exec target for operator scripts, which read Mongo and
// Postgres and never call the Kubernetes API from inside it (F539).
// Pods the backend creates at runtime (agent gateways) run as the separate
// agent-runtime account; the pod spec is checked by
// backend/__tests__/unit/services/gatewayProvisionerServiceK8s.serviceAccount.test.js,
// and this script checks the account itself: it renders in every lane, mounts
// no token, no RoleBinding or ClusterRoleBinding the chart renders names it
// (as the ServiceAccount, its user name, or a group that holds it:
// system:authenticated, system:serviceaccounts, system:serviceaccounts:<ns>), and the backend, its worker and ops-runner are told its
// name. Bindings made outside the chart are not visible here.
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
// The chart names the account from values, so read it rather than assume it.
// `json: true` takes the last of a duplicated key, as Helm does.
const chartValues = yaml.load(require('fs').readFileSync(`${chart}/values.yaml`, 'utf8'), { json: true });
const PROVISIONER = chartValues.rbac.serviceAccount.name;
const AGENT_RUNTIME = chartValues.agentProvisioning.runtimeServiceAccount;
// Exempt by kind and name: only these Deployments provision agents.
const NEEDS_TOKEN = new Set(['Deployment/backend', 'Deployment/backend-worker']);

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

// Without a token the service-account namespace file is gone too, and backend
// scripts read it to know where they run (backend/scripts/staging-seed.ts falls
// back to POD_NAMESPACE, and refuses without either). So a backend-image
// workload that mounts no token gets its namespace from the Downward API.
const backendImage = (docs) => docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'backend')
  ?.spec.template.spec.containers[0].image;
const setsPodNamespace = (spec) => (spec.containers || []).every((c) => (c.env || []).some((e) => e.name === 'POD_NAMESPACE'
  && e.valueFrom?.fieldRef?.fieldPath === 'metadata.namespace'));

const failures = [];
let checked = 0;
if (!AGENT_RUNTIME || AGENT_RUNTIME === PROVISIONER) {
  failures.push(`agentProvisioning.runtimeServiceAccount must name its own account, not ${PROVISIONER}`);
}
for (const lane of Object.keys(lanes)) {
  const docs = render(lane);
  const accounts = new Map(docs.filter((d) => d.kind === 'ServiceAccount').map((d) => [d.metadata.name, d]));
  // The account agent pods run as: present, tokenless, bound to nothing, and
  // the one the provisioning workloads are told about.
  const runtimeAccount = accounts.get(AGENT_RUNTIME);
  if (!runtimeAccount) {
    failures.push(`${lane}: no ServiceAccount/${AGENT_RUNTIME}, so a provisioned agent pod would name an account that does not exist`);
  } else if (runtimeAccount.automountServiceAccountToken !== false) {
    failures.push(`${lane}: ServiceAccount/${AGENT_RUNTIME} must set automountServiceAccountToken: false`);
  }
  const runtimeNs = runtimeAccount?.metadata.namespace;
  const namesRuntime = (s) => (s.kind === 'ServiceAccount' && s.name === AGENT_RUNTIME)
    || (s.kind === 'User' && s.name === `system:serviceaccount:${runtimeNs}:${AGENT_RUNTIME}`)
    || (s.kind === 'Group' && ['system:authenticated', 'system:serviceaccounts', `system:serviceaccounts:${runtimeNs}`].includes(s.name));
  for (const binding of docs.filter((d) => d.kind === 'RoleBinding' || d.kind === 'ClusterRoleBinding')) {
    if ((binding.subjects || []).some(namesRuntime)) {
      failures.push(`${lane}: ${binding.kind}/${binding.metadata.name} binds ${AGENT_RUNTIME}; agent pods must hold no Role`);
    }
  }
  // Each renders in every lane (extraSets turns the worker on), so a missing
  // one is a failure, never a skip.
  for (const name of ['backend', 'backend-worker', 'ops-runner']) {
    const deployment = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === name);
    if (!deployment) {
      failures.push(`${lane}: Deployment/${name} does not render, so its AGENT_RUNTIME_SERVICE_ACCOUNT can't be checked`);
      continue;
    }
    const env = deployment.spec.template.spec.containers.flatMap((c) => c.env || []);
    const named = env.find((e) => e.name === 'AGENT_RUNTIME_SERVICE_ACCOUNT')?.value;
    if (named !== AGENT_RUNTIME) {
      failures.push(`${lane}: Deployment/${name} sets AGENT_RUNTIME_SERVICE_ACCOUNT=${named}, not ${AGENT_RUNTIME}`);
    }
  }
  const image = backendImage(docs);
  for (const doc of docs) {
    const spec = podSpecOf(doc);
    if (!spec) continue;
    const account = spec.serviceAccountName || spec.serviceAccount || 'default';
    if (account !== PROVISIONER) continue;
    checked += 1;
    const name = doc.metadata.name;
    if (NEEDS_TOKEN.has(`${doc.kind}/${name}`)) continue;
    const mounts = spec.automountServiceAccountToken ?? accounts.get(account)?.automountServiceAccountToken ?? true;
    if (mounts !== false) {
      failures.push(`${lane}: ${doc.kind}/${name} runs as ${PROVISIONER} and mounts its token; set automountServiceAccountToken: false or give it its own account`);
    } else if (image && (spec.containers || []).some((c) => c.image === image) && !setsPodNamespace(spec)) {
      failures.push(`${lane}: ${doc.kind}/${name} runs the backend image with no token, so it has no service-account namespace file; `
        + 'set POD_NAMESPACE from fieldRef metadata.namespace');
    }
  }
}

if (!checked) failures.push(`no workload rendered as ${PROVISIONER}; the check is not reading the chart`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`ok: ${checked} workloads render as ${PROVISIONER} across ${Object.keys(lanes).length} lanes; `
  + `only ${[...NEEDS_TOKEN].join(', ')} mount its token; ${AGENT_RUNTIME} renders tokenless and unbound`);
