#!/usr/bin/env node
/**
 * Stranger-path smoke (ADR-023 W2) — the whole activation loop as a REAL
 * non-admin account, against a live instance. Admin smokes lie: they bypass
 * the hosted cap and the entitlement fork, which are exactly the gates a
 * stranger hits. This script is the fixture that can't lie.
 *
 * Flow (all API-level; the UI variant is the same calls the page makes):
 *   1. login as the standing non-admin account (or register a fresh one
 *      with --register, open-registration instances only)
 *   2. GET  /api/hosted/availability          → configured:true
 *   3. ensure a private pod to install into
 *   4. POST /api/registry/install             runtimeType 'hosted'
 *   5. POST /api/hosted/provision             → provisioned
 *   6. POST /api/messages/:podId              @mention the agent
 *   7. poll the pod until the agent replies   (timeout → FAIL)
 *   8. cap proof: a SECOND hosted identity must 403 hosted_cap_reached
 *      (the one assertion an admin account can never make)
 *   9. cleanup: deprovision; the installation and identity stay (rule 8)
 *
 * Usage:
 *   COMMONLY_SMOKE_EMAIL=... COMMONLY_SMOKE_PASSWORD=... \
 *     node scripts/smoke-stranger-path.mjs [--base https://api.commonly.me]
 *
 * Operator note: dev credentials live in ~/.commonly/stranger-smoke.json
 * (0600, operator-local). Exit 0 = every step passed; first failure exits 1
 * with the step name — silence is never success here.
 */

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = (flag('base', process.env.COMMONLY_API_URL || 'https://api.commonly.me')).replace(/\/+$/, '');
const REGISTER = args.includes('--register');

const now = Date.now();
const agentName = `smoke-stranger-${now.toString(36)}`;
const capProbeName = `${agentName}-cap`;

let step = 'init';
const fail = (msg) => {
  console.error(`FAIL at [${step}]: ${msg}`);
  process.exit(1);
};

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'commonly-smoke/stranger-path',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
};

const main = async () => {
  // 1. credentials
  step = 'credentials';
  let email = process.env.COMMONLY_SMOKE_EMAIL;
  let password = process.env.COMMONLY_SMOKE_PASSWORD;
  if (!email && !REGISTER) {
    try {
      const { readFileSync } = await import('fs');
      const { homedir } = await import('os');
      const saved = JSON.parse(readFileSync(`${homedir()}/.commonly/stranger-smoke.json`, 'utf8'));
      email = saved.email; password = saved.password;
    } catch { /* fall through */ }
  }
  if (REGISTER) {
    const { randomBytes } = await import('crypto');
    email = `smoke-${now.toString(36)}@example.invalid`;
    password = `Sm0ke-${randomBytes(18).toString('base64url')}`;
    step = 'register';
    const r = await api('POST', '/api/auth/register', { body: { username: `smoke-${now.toString(36)}`, email, password } });
    if (r.status !== 201) fail(`register ${r.status}: ${JSON.stringify(r.data)} (invite-only instance? use the standing account)`);
    console.log('registered fresh account (note: needs email verification off or operator-side verify)');
  }
  if (!email || !password) fail('no credentials: set COMMONLY_SMOKE_EMAIL/PASSWORD or create ~/.commonly/stranger-smoke.json');

  step = 'login';
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  if (login.status !== 200 || !login.data?.token) fail(`login ${login.status}: ${JSON.stringify(login.data)}`);
  const token = login.data.token;
  const role = login.data.user?.role || 'user';
  if (role === 'admin') fail('this account is ADMIN — the smoke is meaningless (cap/entitlement bypassed). Use a non-admin account.');
  console.log(`ok login (role=${role})`);

  // 2. availability
  step = 'availability';
  const avail = await api('GET', '/api/hosted/availability', { token });
  if (avail.status !== 200 || avail.data?.configured !== true) fail(`availability ${avail.status}: ${JSON.stringify(avail.data)}`);
  console.log(`ok availability (caps: ${avail.data.caps.agentsPerUser} agent, ${avail.data.caps.turnsPerDay} turns/day)`);

  // 3. a pod to install into
  step = 'pod';
  const pods = await api('GET', '/api/pods', { token });
  if (pods.status !== 200) fail(`pods ${pods.status}`);
  let pod = (Array.isArray(pods.data) ? pods.data : []).find((p) => !p.publicRead && !['agent-room', 'agent-dm', 'agent-admin'].includes(p.type || ''));
  if (!pod) {
    const created = await api('POST', '/api/pods', { token, body: { name: 'Smoke workspace', type: 'team' } });
    pod = created.data?.pod || created.data;
    if (!pod?._id) fail(`pod create ${created.status}: ${JSON.stringify(created.data)}`);
  }
  console.log(`ok pod ${pod._id}`);

  // 4. hosted install
  step = 'install';
  const install = await api('POST', '/api/registry/install', {
    token,
    body: { agentName, podId: pod._id, displayName: agentName, config: { runtime: { runtimeType: 'hosted' } }, scopes: [] },
  });
  if (install.status >= 400) fail(`install ${install.status}: ${JSON.stringify(install.data)}`);
  console.log('ok install (hosted)');

  // 5. provision
  step = 'provision';
  const prov = await api('POST', '/api/hosted/provision', { token, body: { agentName } });
  if (prov.status !== 200 || !prov.data?.provisioned) fail(`provision ${prov.status}: ${JSON.stringify(prov.data)}`);
  console.log('ok provision');

  // 6. mention
  step = 'mention';
  const mention = await api('POST', `/api/messages/${pod._id}`, {
    token,
    body: { content: `@${agentName} smoke check: reply with one short sentence containing the word KINGFISHER.` },
  });
  if (mention.status !== 200) fail(`mention ${mention.status}: ${JSON.stringify(mention.data)}`);
  const enq = mention.data?.agentDelivery?.enqueued ?? 0;
  if (enq < 1) fail(`mention enqueued=${enq} — the agent never received the event`);
  console.log('ok mention (enqueued)');

  // 7. reply
  step = 'reply';
  const t0 = Date.now();
  let replied = false;
  while (Date.now() - t0 < 120_000) {
    await new Promise((r) => setTimeout(r, 5000));
    const msgs = await api('GET', `/api/pg/messages/${pod._id}?limit=5`, { token });
    const list = Array.isArray(msgs.data) ? msgs.data : [];
    if (list.some((m) => String(m.content || '').includes('KINGFISHER') && !String(m.content).includes('smoke check:'))) {
      console.log(`ok reply in ~${Math.round((Date.now() - t0) / 1000)}s`);
      replied = true;
      break;
    }
  }
  if (!replied) fail('no reply within 120s (check worker /status lastError)');

  // 8. cap proof — the assertion an admin can never make
  step = 'cap';
  const capInstall = await api('POST', '/api/registry/install', {
    token,
    body: { agentName: capProbeName, podId: pod._id, displayName: capProbeName, config: { runtime: { runtimeType: 'hosted' } }, scopes: [] },
  });
  if (capInstall.status !== 403 || capInstall.data?.code !== 'hosted_cap_reached') {
    fail(`cap probe expected 403 hosted_cap_reached, got ${capInstall.status}: ${JSON.stringify(capInstall.data)}`);
  }
  console.log('ok cap (second hosted install refused)');

  // 9. cleanup — runtime only; identity stays (rule 8)
  step = 'cleanup';
  const deprov = await api('POST', '/api/hosted/deprovision', { token, body: { agentName } });
  if (deprov.status !== 200) console.warn(`warn: deprovision ${deprov.status} (agent left running)`);
  else console.log('ok deprovision');

  console.log('\nSTRANGER PATH: PASS — login, availability, install, provision, mention, reply, cap, cleanup.');
};

main().catch((e) => fail(e?.stack || String(e)));
