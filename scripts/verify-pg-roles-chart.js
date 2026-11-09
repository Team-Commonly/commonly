#!/usr/bin/env node
// A separate Postgres role per component: backend.env.pgAppUser/pgAppPasswordKey
// move only the backend, litellm.pgUser/pgPasswordKey move only LiteLLM, and
// ops-runner and the backup CronJob stay on backend.env.pgUser. Unset, every
// consumer keeps pgUser and postgres-password. Renders the chart itself:
//   node scripts/verify-pg-roles-chart.js
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const chart = 'k8s/helm/commonly';
const lanes = {
  default: [`${chart}/values.yaml`],
  dev: [`${chart}/values.yaml`, `${chart}/values-dev.yaml`],
  staging: [`${chart}/values.yaml`, `${chart}/values-dev.yaml`, `${chart}/values-staging.yaml`],
};
const ROLES = [
  'backend.env.pgAppUser=app_role', 'backend.env.pgAppPasswordKey=postgres-app-password',
  'litellm.pgUser=llm_role', 'litellm.pgPasswordKey=postgres-litellm-password',
];

const render = (lane, sets = []) => {
  const args = ['template', `commonly-${lane}`, chart];
  for (const f of lanes[lane]) args.push('-f', f);
  for (const s of sets) args.push('--set', s);
  return yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).filter(Boolean);
};
const refuses = (lane, sets) => {
  try { render(lane, sets); return false; } catch { return true; }
};

const podSpec = (d) => (d.kind === 'CronJob' ? d.spec.jobTemplate.spec.template.spec : d.spec.template.spec);
const env = (docs, kind, name) => {
  const d = docs.find((x) => x.kind === kind && x.metadata?.name === name);
  if (!d) return null;
  const out = {};
  for (const c of [...(podSpec(d).initContainers || []), ...podSpec(d).containers]) {
    for (const e of c.env || []) out[e.name] = e.value ?? `key:${e.valueFrom?.secretKeyRef?.key}`;
  }
  return out;
};
// Who reads PG_USER/PG_PASSWORD, and under which names.
const consumers = (docs) => ({
  backend: env(docs, 'Deployment', 'backend'),
  'backend-worker': env(docs, 'Deployment', 'backend-worker'),
  'ops-runner': env(docs, 'Deployment', 'ops-runner'),
  backup: env(docs, 'CronJob', 'postgres-backup'),
});
const userOf = (e) => e.PG_USER;
const keyOf = (e) => e.PG_PASSWORD || e.PGPASSWORD;
const litellm = (docs) => {
  const e = env(docs, 'Deployment', 'litellm');
  return e && { user: /^postgresql:\/\/([^:]+):/.exec(e.DATABASE_URL || '')?.[1], key: e.PG_PASSWORD };
};
const esKeys = (docs) => {
  const d = docs.find((x) => x.kind === 'ExternalSecret' && x.metadata?.name === 'database-credentials');
  return d && d.spec.data.map((x) => `${x.secretKey}<-${x.remoteRef.key}`).sort();
};

const failures = [];
const expect = (cond, msg) => { if (!cond) failures.push(msg); };

for (const lane of Object.keys(lanes)) {
  const base = render(lane, ['backend.worker.enabled=true']);
  const set = render(lane, ['backend.worker.enabled=true', ...ROLES]);
  const baseUser = userOf(consumers(base).backend);
  expect(baseUser, `${lane}: backend renders no PG_USER`);

  for (const [name, e] of Object.entries(consumers(base))) {
    if (!e) continue;
    expect(userOf(e) === baseUser, `${lane}: ${name} PG_USER=${userOf(e)} unset, want ${baseUser}`);
    expect(keyOf(e) === 'key:postgres-password', `${lane}: ${name} password ${keyOf(e)} unset`);
  }
  for (const [name, e] of Object.entries(consumers(set))) {
    if (!e) continue;
    const moves = name === 'backend' || name === 'backend-worker';
    expect(userOf(e) === (moves ? 'app_role' : baseUser), `${lane}: ${name} PG_USER=${userOf(e)} with roles set`);
    expect(keyOf(e) === (moves ? 'key:postgres-app-password' : 'key:postgres-password'), `${lane}: ${name} password ${keyOf(e)} with roles set`);
  }

  const lBase = litellm(base);
  const lSet = litellm(set);
  if (lBase) {
    expect(lBase.user === baseUser && lBase.key === 'key:postgres-password', `${lane}: litellm unset is ${JSON.stringify(lBase)}`);
    expect(lSet.user === 'llm_role' && lSet.key === 'key:postgres-litellm-password', `${lane}: litellm set is ${JSON.stringify(lSet)}`);
  }

  const esBase = esKeys(base);
  if (esBase) {
    const prefix = esBase.find((k) => k.startsWith('postgres-password<-')).slice('postgres-password<-'.length, -'postgres-password'.length);
    expect(esBase.length === 3, `${lane}: database-credentials unset syncs ${esBase.join(', ')}`);
    expect(JSON.stringify(esKeys(set)) === JSON.stringify([...esBase, `postgres-app-password<-${prefix}postgres-app-password`, `postgres-litellm-password<-${prefix}postgres-litellm-password`].sort()),
      `${lane}: database-credentials with roles set syncs ${esKeys(set).join(', ')}`);
    const shared = esKeys(render(lane, [
      'backend.env.pgAppUser=app_role', 'backend.env.pgAppPasswordKey=postgres-role-password',
      'litellm.pgUser=llm_role', 'litellm.pgPasswordKey=postgres-role-password',
    ]));
    expect(shared.length === 4, `${lane}: a key shared by both roles syncs ${shared.join(', ')}`);
  }

  // The positive control: dev, the lane that deploys, renders every consumer.
  if (lane === 'dev') {
    for (const [name, e] of Object.entries(consumers(set))) expect(e, `${lane}: ${name} not rendered`);
    expect(lSet, `${lane}: litellm not rendered`);
  }

  expect(refuses(lane, ['backend.env.pgAppUser=app_role']), `${lane}: a backend role without its password key renders`);
  expect(refuses(lane, ['backend.env.pgAppPasswordKey=postgres-app-password']), `${lane}: a backend password key without its role renders`);
  expect(refuses(lane, ['litellm.enabled=true', 'litellm.pgPasswordKey=postgres-litellm-password']), `${lane}: a litellm password key without its role renders`);
  expect(refuses(lane, ['backend.env.pgAppUser=app_role', 'backend.env.pgAppPasswordKey=mongo-uri']), `${lane}: a Postgres role on mongo-uri renders`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('verify-pg-roles-chart: ok');
