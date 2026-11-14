#!/usr/bin/env node
// The egress policies (templates/network/egress-restrict.yaml): pods may reach
// any address except exceptCidrs; pods whose component is in exemptComponents
// keep full egress (backup uses Workload Identity). With
// networkPolicy.egress.restrict on (the dev and staging lanes), both policies
// render in the release namespace: egress-restrict cuts exactly
// 169.254.169.254/32 for every pod but backup's (169.254.20.10 stays
// reachable), and egress-restrict-exempt gives the backup pods full egress.
// With it off (the default lane), neither renders. The dev lane renders both
// backup CronJobs; staging runs none, so a staging+backup lane turns them on.
// Both check the selectors against real pods.
// Renders the chart itself:
//   node scripts/verify-network-policy-chart.js
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const chart = 'k8s/helm/commonly';
const lanes = {
  default: { files: [`${chart}/values.yaml`], on: false },
  dev: { files: [`${chart}/values.yaml`, `${chart}/values-dev.yaml`], on: true, backups: 2 },
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
  expect(blocks.length === 1 && blocks[0].cidr === '0.0.0.0/0',
    `${lane}: egress-restrict is not one 0.0.0.0/0 ipBlock rule`);
  // In-cluster traffic is allowed outright, so it never rests on how the
  // dataplane matches pod IPs against an ipBlock.
  const peers = (restrict.spec.egress || []).flatMap((r) => r.to || []);
  expect(restrict.spec.egress?.length === 2
    && peers.some((t) => t.namespaceSelector && Object.keys(t.namespaceSelector).length === 0 && !t.podSelector),
    `${lane}: egress-restrict lacks the all-namespaces rule`);
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

// The ingress policies (templates/network/ingress-allow.yaml). Under
// default-deny-ingress, every known in-cluster flow must still be admitted,
// and every Service's pods admitted on the Service's own port, so a Service
// added later without an allow fails here rather than on staging. The
// dev+ingress lane turns every policy on in dev's shape to check the prod
// flows before prod turns them on.
const DEV_EDGE = [{
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/component': 'controller' } },
}];
// Dev's data tier is outside the cluster, so dev renders no mongodb or email-sink.
const DEV_INGRESS_KEYS = ['frontend', 'backend', 'litellm', 'redis', 'agentComputer', 'defaultDeny'];
// A switch whose policy names aren't allow-<key>-ingress (ingress-allow.yaml).
const POLICY_NAMES = {
  agentComputer: ['allow-agent-computer-waker-ingress', 'allow-agent-computer-steel-ingress'],
  emailSink: ['allow-email-sink-ingress'],
};
// Prod's agent computer users come from the private values file, so a lane
// that checks those allows names one user to render the waker and a gate.
const ONE_AGENT_COMPUTER_USER = ['backend.env.agentComputerEnabled="true"', 'agentComputer.users=["0123456789abcdef01234567"]'];
const ingressLanes = {
  default: { files: lanes.default.files, on: [] },
  // Prod's steps 1 and 2: frontend, redis and agent-computer allows, no deny.
  // Each allow isolates the pods it selects as soon as it applies, so its
  // clients must be whole.
  dev: {
    files: lanes.dev.files,
    setJson: ONE_AGENT_COMPUTER_USER,
    on: ['frontend', 'redis', 'agentComputer'],
    deny: false,
    edgeIs: DEV_EDGE,
    flows: [
      ['edge', 'frontend', 80],
      ...['backend', 'backend-worker', 'ops-runner'].flatMap((a) => [[`app=${a}`, 'redis', 6379],
        [`app=${a}`, 'agent-computer-waker', 8080], [`app=${a}`, 'agent-computer-steel', 3000]]),
    ],
    // The tunnel shares the controller's namespace but must go through it.
    // Steel is reached only through the broker, never from the edge.
    closed: [['ns:ingress-nginx/app=cloudflared-commonly-k8s', 'frontend', 80], ['app=backend', 'frontend', 80],
      ['edge', 'redis', 6379], ['app=commonly-bot', 'redis', 6379], ['app=cloud-codex', 'redis', 6379],
      ['edge', 'agent-computer-steel', 3000], ['edge', 'agent-computer-waker', 8080],
      ['app=commonly-bot', 'agent-computer-steel', 3000], ['app=cloud-codex', 'agent-computer-waker', 8080],
      ['app=agent-computer-waker', 'agent-computer-steel', 3000]],
  },
  staging: {
    files: lanes.staging.files,
    // Staging runs no backups and no ops-runner, but its allows admit both.
    // Render them, so those flows are checked against real pods.
    setJson: ['backup.mongodb.enabled=true', 'backup.postgresql.enabled=true', 'opsRunner.enabled=true'],
    on: ['frontend', 'backend', 'litellm', 'redis', 'mongodb', 'emailSink', 'defaultDeny'],
    edgeApp: 'cloudflared-commonly-k8s',
    flows: [
      ['app=cloudflared-commonly-k8s', 'frontend', 80], ['app=cloudflared-commonly-k8s', 'backend', 5000],
      ['app=backend', 'litellm', 4000], ['app=backend-worker', 'litellm', 4000],
      ['app=backend', 'redis', 6379], ['app=backend-worker', 'redis', 6379],
      ['app=backend', 'mongodb', 27017], ['app=backend-worker', 'mongodb', 27017], ['component=backup', 'mongodb', 27017],
      ['app=backend', 'email-sink', 8080], ['app=backend-worker', 'email-sink', 8080], ['app=ops-runner', 'email-sink', 8080],
      ['component=stranger-journey', 'email-sink', 8080],
    ],
    // Nothing outside the namespace's tunnel reaches these.
    closed: [['app=backend', 'frontend', 80], ['app=litellm', 'redis', 6379], ['app=frontend', 'backend', 5000], ['app=cloudflared-commonly-k8s', 'litellm', 4000]],
  },
  'dev+ingress': {
    files: lanes.dev.files,
    setJson: [`networkPolicy.ingress.edge=${JSON.stringify(DEV_EDGE)}`, 'networkPolicy.ingress.litellm.public=true',
      ...DEV_INGRESS_KEYS.map((k) => `networkPolicy.ingress.${k}.enabled=true`),
      // One agent computer user, so the waker and a steel gate render.
      ...ONE_AGENT_COMPUTER_USER],
    on: DEV_INGRESS_KEYS,
    edge: true,
    flows: [
      ['edge', 'frontend', 80], ['edge', 'backend', 5000], ['edge', 'litellm', 4000],
      ...['backend', 'backend-worker', 'commonly-bot', 'ops-runner', 'cloud-codex'].flatMap((a) => [[`app=${a}`, 'backend', 5000], [`app=${a}`, 'litellm', 4000]]),
      ...['backend', 'backend-worker', 'ops-runner'].flatMap((a) => [[`app=${a}`, 'redis', 6379],
        [`app=${a}`, 'agent-computer-waker', 8080], [`app=${a}`, 'agent-computer-steel', 3000]]),
    ],
    closed: [['app=commonly-bot', 'redis', 6379], ['app=cloud-codex', 'agent-computer-steel', 3000], ['edge', 'redis', 6379], ['app=frontend', 'litellm', 4000]],
  },
};
const peerLabels = (spec) => {
  if (spec === 'edge') return { ns: 'ingress-nginx', labels: { 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/component': 'controller' } };
  // `ns:<namespace>/key=value` is a pod in another namespace; bare `key=value`
  // is in the chart's. Only the prefix names a namespace: a label key can carry
  // its own `/` (app.kubernetes.io/name), so a bare `/` can't.
  const m = /^ns:([^/]+)\/(.+)$/.exec(spec);
  // A malformed prefix would read as a label key in the chart's namespace, and
  // a closed check on it would pass vacuously.
  if (!m && spec.startsWith('ns:')) throw new Error(`peer spec ${spec} is not ns:<namespace>/key=value`);
  const label = m ? m[2] : spec;
  const eq = label.indexOf('=');
  if (eq < 1) throw new Error(`peer spec ${spec} is not key=value`);
  return { ns: m ? m[1] : null, labels: { [label.slice(0, eq)]: label.slice(eq + 1) } };
};
// Does a policy's `from` admit a pod with these labels (ns null = the policy's
// own namespace)? An ipBlock counts as admitting: pod IPs can fall inside it,
// so a broad one must fail the closed checks, never pass them.
const admits = (pol, { ns, labels }, port) => (pol.spec.ingress || []).some((rule) => {
  const portOk = !rule.ports || rule.ports.some((p) => p.port === port);
  const fromNs = ns ?? pol.metadata.namespace;
  const fromOk = !rule.from || rule.from.some((peer) => {
    if (peer.ipBlock) return true;
    const nsOk = peer.namespaceSelector
      ? selects(peer.namespaceSelector, { 'kubernetes.io/metadata.name': fromNs })
      : ns === null;
    return nsOk && (!peer.podSelector || selects(peer.podSelector, labels));
  });
  return portOk && fromOk;
});

for (const [lane, cfg] of Object.entries(ingressLanes)) {
  const args = ['template', 'commonly-verify', chart];
  for (const f of cfg.files) args.push('-f', f);
  for (const s of cfg.setJson || []) args.push('--set-json', s);
  const docs = yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).filter(Boolean);
  const policies = docs.filter((d) => d.kind === 'NetworkPolicy' && (d.spec.policyTypes || []).includes('Ingress'));
  const deny = policies.find((p) => p.metadata.name === 'default-deny-ingress');
  const allows = policies.filter((p) => p !== deny);
  if (!cfg.on.length) {
    expect(policies.length === 0, `${lane}: ingress policies render with every switch off: ${policies.map((p) => p.metadata.name).join(', ')}`);
    continue;
  }
  if (cfg.deny === false) {
    expect(!deny, `${lane}: default-deny-ingress renders, want the allows alone`);
    const want = cfg.on.flatMap((k) => POLICY_NAMES[k] || [`allow-${k}-ingress`]).sort();
    const got = allows.map((p) => p.metadata.name).sort();
    expect(JSON.stringify(got) === JSON.stringify(want), `${lane}: ingress allows are ${got.join(', ')}, want ${want.join(', ')}`);
  } else {
    expect(deny && Object.keys(deny.spec.podSelector || {}).length === 0 && !deny.spec.ingress,
      `${lane}: no default-deny-ingress over every pod`);
  }
  if (cfg.edgeIs) {
    const edgePolicy = allows.find((p) => p.metadata.name === 'allow-frontend-ingress');
    // Frontend admits the edge alone, so every one of its peers must be the
    // edge: a stray ipBlock or namespace-wide peer would open it to more.
    const edgePeers = (edgePolicy?.spec.ingress || []).flatMap((r) => r.from || []);
    // Helm renders keys sorted, so compare with keys sorted on both sides.
    const canon = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((key) => [key, val[key]])) : val));
    expect(canon(edgePeers) === canon(cfg.edgeIs), `${lane}: the edge peer is ${JSON.stringify(edgePeers)}, want the ingress-nginx controller`);
  }
  const workloads = docs.filter((d) => ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job'].includes(d.kind) && podTemplate(d));
  const ns = (deny || policies[0])?.metadata.namespace;
  for (const p of policies) expect(p.metadata.namespace === ns, `${lane}: ${p.metadata.name} renders outside ${ns}`);
  const podsOf = (app) => workloads.filter((w) => w.metadata.namespace === ns && podTemplate(w).metadata?.labels?.app === app);
  // Every allow targets real pods, so a renamed label can't leave one guarding nothing.
  for (const p of allows) {
    expect(workloads.some((w) => selects(p.spec.podSelector, podTemplate(w).metadata?.labels)), `${lane}: ${p.metadata.name} selects no rendered pod`);
  }
  if (cfg.edgeApp) {
    expect(podsOf(cfg.edgeApp).length > 0, `${lane}: the edge ${cfg.edgeApp} is not rendered in ${ns}`);
  }
  const admitted = (from, toApp, port) => allows.some((p) => selects(p.spec.podSelector, { app: toApp }) && admits(p, peerLabels(from), port));
  for (const [from, toApp, port] of cfg.flows) {
    expect(admitted(from, toApp, port), `${lane}: ${from} -> ${toApp}:${port} is refused`);
    // The source is built from this spec, not from a pod: a renamed label
    // would leave the flow passing here while the real pod is cut off.
    const src = from === 'edge' ? null : peerLabels(from);
    if (src && src.ns === null) {
      expect(workloads.some((w) => w.metadata.namespace === ns && selects({ matchLabels: src.labels }, podTemplate(w).metadata?.labels)),
        `${lane}: flow source ${from} matches no rendered pod in ${ns}`);
    }
  }
  for (const [from, toApp, port] of cfg.closed) {
    expect(!admitted(from, toApp, port), `${lane}: ${from} -> ${toApp}:${port} is admitted, want refused`);
  }
  // Every Service's pods are admitted on the port the Service sends to. With no
  // deny, only the pods an allow selects are isolated, so only they are checked.
  const isolated = (labels) => cfg.deny !== false || allows.some((p) => selects(p.spec.podSelector, labels));
  for (const svc of docs.filter((d) => d.kind === 'Service' && d.metadata.namespace === ns && d.spec.selector)) {
    const selected = workloads.filter((w) => w.metadata.namespace === ns && selects({ matchLabels: svc.spec.selector }, podTemplate(w).metadata?.labels));
    // A Service with no rendered backend would pass the loop below unchecked.
    expect(selected.length > 0, `${lane}: Service ${svc.metadata.name} selects no rendered workload, so its allow can't be checked`);
    const backends = selected.filter((w) => isolated(podTemplate(w).metadata?.labels));
    for (const w of backends) {
      const containers = podTemplate(w).spec.containers || [];
      for (const sp of svc.spec.ports || []) {
        const target = sp.targetPort ?? sp.port;
        const port = typeof target === 'number' ? target
          : containers.flatMap((c) => c.ports || []).find((cp) => cp.name === target)?.containerPort;
        const labels = podTemplate(w).metadata.labels;
        expect(allows.some((p) => selects(p.spec.podSelector, labels) && (p.spec.ingress || []).some((r) => (r.ports || []).some((rp) => rp.port === port))),
          `${lane}: Service ${svc.metadata.name} sends to ${w.metadata.name}:${port}, which no allow admits`);
      }
    }
  }
}

// admits() itself: a namespaceSelector peer that covers the policy's own
// namespace admits same-namespace pods, and an ipBlock counts as admitting,
// so neither can make a closed check pass.
const probe = (peer) => admits({ metadata: { namespace: 'n' }, spec: { ingress: [{ from: [peer], ports: [{ port: 1 }] }] } },
  { ns: null, labels: { app: 'x' } }, 1);
expect(probe({ namespaceSelector: {} }), 'admits(): a namespaceSelector {} peer does not admit a same-namespace pod');
expect(probe({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'n' } } }), 'admits(): a peer naming the own namespace does not admit its pods');
expect(!probe({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'other' } } }), 'admits(): a peer naming another namespace admits same-namespace pods');
expect(probe({ ipBlock: { cidr: '0.0.0.0/0' } }), 'admits(): an ipBlock peer is treated as refusing');

// peerLabels() itself: a prefixed label key carries a `/` of its own, so it
// must stay a label in the chart's namespace. Read as a namespace, its closed
// check would pass without testing anything.
const parsed = (spec) => JSON.stringify(peerLabels(spec));
expect(parsed('app.kubernetes.io/name=x') === JSON.stringify({ ns: null, labels: { 'app.kubernetes.io/name': 'x' } }),
  `peerLabels(): app.kubernetes.io/name=x reads as ${parsed('app.kubernetes.io/name=x')}, want a prefixed label in the chart's namespace`);
expect(parsed('ns:ingress-nginx/app.kubernetes.io/name=x') === JSON.stringify({ ns: 'ingress-nginx', labels: { 'app.kubernetes.io/name': 'x' } }),
  `peerLabels(): ns:ingress-nginx/app.kubernetes.io/name=x reads as ${parsed('ns:ingress-nginx/app.kubernetes.io/name=x')}`);

// An edge peer must name pods: a bare namespaceSelector or an ipBlock would
// admit whole namespaces or address ranges to frontend and backend.
for (const bad of [[{ namespaceSelector: {} }], [{ ipBlock: { cidr: '0.0.0.0/0' } }], [{ podSelector: {} }]]) {
  let rendered = true;
  try {
    execFileSync('helm', ['template', 'commonly-verify', chart, '-f', lanes.dev.files[0], '-f', lanes.dev.files[1],
      '--set', 'networkPolicy.ingress.frontend.enabled=true', '--set-json', `networkPolicy.ingress.edge=${JSON.stringify(bad)}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rendered = false;
    expect(/each peer must name the edge pods/.test(String(e.stderr)), `edge ${JSON.stringify(bad)} failed for another reason: ${String(e.stderr).trim().split('\n')[0]}`);
  }
  expect(!rendered, `edge ${JSON.stringify(bad)} renders, admitting more than the edge pods`);
}

// A policy that admits the edge must refuse to render without one: an empty
// from-list admits every source.
for (const key of ['frontend', 'backend']) {
  let rendered = true;
  try {
    execFileSync('helm', ['template', 'commonly-verify', chart, '-f', lanes.dev.files[0], '-f', lanes.dev.files[1],
      // Dev's values carry an edge since prod's first step, so clear it here.
      '--set', `networkPolicy.ingress.${key}.enabled=true`, '--set-json', 'networkPolicy.ingress.edge=[]'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rendered = false;
    expect(/needs networkPolicy\.ingress\.edge/.test(String(e.stderr)), `${key} with no edge failed for another reason: ${String(e.stderr).trim().split('\n')[0]}`);
  }
  expect(!rendered, `networkPolicy.ingress.${key} renders with an empty edge, which admits every source`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('verify-network-policy-chart: ok');
