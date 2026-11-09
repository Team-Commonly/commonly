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
  local: [`${chart}/values.yaml`, `${chart}/values-local.yaml`],
};
const BACKEND_ROLE = ['backend.env.pgAppUser=app_role', 'backend.env.pgAppPasswordKey=postgres-app-password'];
const LITELLM_ROLE = ['litellm.pgUser=llm_role', 'litellm.pgPasswordKey=postgres-litellm-password'];
const ROLES = [...BACKEND_ROLE, ...LITELLM_ROLE];

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
  const baseUser = userOf(consumers(base).backend);
  expect(baseUser, `${lane}: backend renders no PG_USER`);
  for (const [name, e] of Object.entries(consumers(base))) {
    if (!e) continue;
    expect(userOf(e) === baseUser, `${lane}: ${name} PG_USER=${userOf(e)} unset, want ${baseUser}`);
    expect(keyOf(e) === 'key:postgres-password', `${lane}: ${name} password ${keyOf(e)} unset`);
  }
  const lBase = litellm(base);
  if (lBase) expect(lBase.user === baseUser && lBase.key === 'key:postgres-password', `${lane}: litellm unset is ${JSON.stringify(lBase)}`);

  // Bad pairs fail the render in every lane, LiteLLM on or off.
  for (const litellmOn of ['true', 'false']) {
    const on = `litellm.enabled=${litellmOn}`;
    expect(refuses(lane, [on, 'backend.env.pgAppUser=app_role']), `${lane} ${on}: a backend role without its password key renders`);
    expect(refuses(lane, [on, 'backend.env.pgAppPasswordKey=postgres-app-password']), `${lane} ${on}: a backend password key without its role renders`);
    expect(refuses(lane, [on, 'litellm.pgPasswordKey=postgres-litellm-password']), `${lane} ${on}: a litellm password key without its role renders`);
    expect(refuses(lane, [on, 'litellm.pgUser=llm_role']), `${lane} ${on}: a litellm role without its password key renders`);
    expect(refuses(lane, [on, 'backend.env.pgAppUser=app_role', 'backend.env.pgAppPasswordKey=mongo-uri']), `${lane} ${on}: a backend role on mongo-uri renders`);
    expect(refuses(lane, [on, 'litellm.pgUser=llm_role', 'litellm.pgPasswordKey=mongo-password']), `${lane} ${on}: a litellm role on mongo-password renders`);
    expect(refuses(lane, [on, 'litellm.pgUser=svc:prod', 'litellm.pgPasswordKey=postgres-litellm-password']), `${lane} ${on}: a litellm role that isn't a plain name renders`);
    expect(refuses(lane, [on, 'backend.env.pgAppUser=App-Role', 'backend.env.pgAppPasswordKey=postgres-app-password']), `${lane} ${on}: a backend role that isn't a plain name renders`);
  }

  const esBase = esKeys(base);
  if (!esBase) {
    // Without the ExternalSecret the local Secret carries only postgres-password.
    expect(refuses(lane, BACKEND_ROLE), `${lane}: a backend role renders without externalSecrets`);
    expect(refuses(lane, ['litellm.enabled=true', ...LITELLM_ROLE]), `${lane}: a litellm role renders without externalSecrets`);
    continue;
  }

  const set = render(lane, ['backend.worker.enabled=true', ...ROLES]);
  for (const [name, e] of Object.entries(consumers(set))) {
    if (!e) continue;
    const moves = name === 'backend' || name === 'backend-worker';
    expect(userOf(e) === (moves ? 'app_role' : baseUser), `${lane}: ${name} PG_USER=${userOf(e)} with roles set`);
    expect(keyOf(e) === (moves ? 'key:postgres-app-password' : 'key:postgres-password'), `${lane}: ${name} password ${keyOf(e)} with roles set`);
  }
  const lSet = litellm(set);
  if (lSet) expect(lSet.user === 'llm_role' && lSet.key === 'key:postgres-litellm-password', `${lane}: litellm set is ${JSON.stringify(lSet)}`);

  const prefix = esBase.find((k) => k.startsWith('postgres-password<-')).slice('postgres-password<-'.length, -'postgres-password'.length);
  const synced = (key) => `${key}<-${prefix}${key}`;
  expect(esBase.length === 3, `${lane}: database-credentials unset syncs ${esBase.join(', ')}`);
  const want = [...esBase, synced('postgres-app-password'), ...(lSet ? [synced('postgres-litellm-password')] : [])].sort();
  expect(JSON.stringify(esKeys(set)) === JSON.stringify(want), `${lane}: database-credentials with roles set syncs ${esKeys(set).join(', ')}`);
  // A role on a component that isn't deployed asks the store for nothing.
  const off = esKeys(render(lane, ['litellm.enabled=false', ...LITELLM_ROLE]));
  // The ExternalSecret follows the Deployment's own truth test: a truthy string deploys LiteLLM, so its key syncs.
  const truthy = esKeys(render(lane, ['litellm.enabled=yes', ...LITELLM_ROLE]));
  expect(truthy.includes(synced('postgres-litellm-password')), `${lane}: litellm.enabled=yes deploys LiteLLM but syncs ${truthy.join(', ')}`);
  expect(JSON.stringify(off) === JSON.stringify(esBase), `${lane}: a litellm role with litellm off syncs ${off.join(', ')}`);
  const shared = esKeys(render(lane, [
    'litellm.enabled=true',
    'backend.env.pgAppUser=app_role', 'backend.env.pgAppPasswordKey=postgres-role-password',
    'litellm.pgUser=llm_role', 'litellm.pgPasswordKey=postgres-role-password',
  ]));
  expect(JSON.stringify(shared) === JSON.stringify([...esBase, synced('postgres-role-password')].sort()), `${lane}: a key shared by both roles syncs ${shared.join(', ')}`);

  // The positive control: dev, the lane that deploys, renders every consumer.
  if (lane === 'dev') {
    for (const [name, e] of Object.entries(consumers(set))) expect(e, `${lane}: ${name} not rendered`);
    expect(lSet, `${lane}: litellm not rendered`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('verify-pg-roles-chart: ok');
