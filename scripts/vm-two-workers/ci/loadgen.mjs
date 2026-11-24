// Load generator for the two-worker proof (run.sh), after the D343 load test's.
// Runs with node 22 (the backend image), against API (required, no default).
//   node loadgen.mjs setup <users> <agentsPerUser>   writes $STATE/fleet.json
//   node loadgen.mjs poll <agents> <seconds>         BYO pollers, every 5 s each
//   node loadgen.mjs turns <perMinute> <seconds>     human posts that wake Scout
//   node loadgen.mjs mix <agents> <perMinute> <seconds>
// Every request carries a CF-Connecting-IP, as through the tunnel: fixed per
// agent and per user, random during setup (so the register limit never binds).
// Prints one RESULT line per phase.
import fs from 'node:fs';

const API = process.env.API;
const STATE = process.env.STATE || '/state';
if (!API) throw new Error('set API, e.g. http://backend:5000');

const octet = () => Math.floor(Math.random() * 250) + 1;
const randomIp = () => `${(octet() % 200) + 11}.${octet()}.${octet()}.${octet()}`;
const headers = (token, ip = randomIp()) => ({
  'Content-Type': 'application/json',
  'User-Agent': 'commonly-loadgen/1',
  'X-Forwarded-For': ip,
  'CF-Connecting-IP': ip,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function call(method, path, token, body, ip) {
  const t0 = performance.now();
  try {
    const res = await fetch(API + path, {
      method,
      headers: headers(token, ip),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, ms: performance.now() - t0 };
  } catch (error) {
    return { status: 0, json: {}, ms: performance.now() - t0, error: error.name };
  }
}

const findAgentToken = (value) => {
  if (typeof value === 'string' && value.startsWith('cm_agent_')) return value;
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      const found = findAgentToken(inner);
      if (found) return found;
    }
  }
  return null;
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const report = (label, latencies, codes, t0) => {
  const n = latencies.length;
  const bad = Object.entries(codes).filter(([code]) => !/^2/.test(code)).reduce((sum, [, c]) => sum + c, 0);
  console.log(`RESULT ${label} start=${new Date(t0).toISOString()} end=${new Date().toISOString()} n=${n} `
    + `rps=${(n / ((Date.now() - t0) / 1000)).toFixed(1)} p50=${percentile(latencies, 50).toFixed(0)}ms `
    + `p95=${percentile(latencies, 95).toFixed(0)}ms p99=${percentile(latencies, 99).toFixed(0)}ms `
    + `err=${((100 * bad) / Math.max(n, 1)).toFixed(2)}% codes=${JSON.stringify(codes)}`);
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const [, , mode, a1, a2, a3] = process.argv;

if (mode === 'setup') {
  const users = Number(a1);
  const perUser = Number(a2);
  const fleet = { users: [], agents: [] };
  const run = Date.now().toString(36);
  for (let u = 0; u < users; u += 1) {
    const username = `lg${run}u${u}`;
    const email = `${username}@loadtest.invalid`;
    const password = `Lg-${run}-pw-${u}!x`;
    const registered = await call('POST', '/api/auth/register', null, { username, email, password });
    const login = await call('POST', '/api/auth/login', null, { email, password });
    const token = login.json.token;
    if (!token) {
      console.log(`SETUP u${u} register=${registered.status} login=${login.status} ${JSON.stringify(registered.json).slice(0, 200)}`);
      continue;
    }
    const pods = await call('GET', '/api/pods', token);
    const list = Array.isArray(pods.json) ? pods.json : (pods.json.pods || []);
    const pod = list[0];
    if (!pod) { console.log(`SETUP u${u} has no pod`); continue; }
    fleet.users.push({ token, podId: pod._id, ip: randomIp() });
    await Promise.all(Array.from({ length: perUser }, async (_, k) => {
      const name = `lga${u}x${k}`;
      const install = await call('POST', '/api/registry/install', token, {
        agentName: name, podId: pod._id, displayName: name, version: '1.0.0',
        scopes: ['context:read', 'messages:write'], config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
      });
      const minted = await call('POST', `/api/registry/pods/${pod._id}/agents/${name}/runtime-tokens`, token, { label: 'loadgen', force: true });
      const agentToken = findAgentToken(minted.json);
      if (agentToken) fleet.agents.push({ name, token: agentToken, ip: randomIp() });
      else if (k === 0) console.log(`SETUP agent install=${install.status} token=${minted.status} ${JSON.stringify(minted.json).slice(0, 200)}`);
    }));
  }
  fs.writeFileSync(`${STATE}/fleet.json`, JSON.stringify(fleet), { mode: 0o600 });
  console.log(`SETUP done users=${fleet.users.length} agents=${fleet.agents.length}`);
  process.exit(fleet.agents.length ? 0 : 1);
}

const fleet = JSON.parse(fs.readFileSync(`${STATE}/fleet.json`, 'utf8'));

async function pollers(count, seconds, tag) {
  const latencies = [];
  const codes = {};
  const t0 = Date.now();
  const end = t0 + seconds * 1000;
  const agents = fleet.agents.slice(0, count);
  await Promise.all(agents.map(async (agent) => {
    await sleep(Math.random() * 5000);
    while (Date.now() < end) {
      const started = Date.now();
      const res = await call('GET', `/api/agents/runtime/events?agentName=${agent.name}&instanceId=default&limit=10`, agent.token, null, agent.ip);
      // The first 10 s are ramp-up.
      if (Date.now() - t0 > 10000) {
        latencies.push(res.ms);
        codes[res.status] = (codes[res.status] || 0) + 1;
      }
      await sleep(Math.max(0, 5000 - (Date.now() - started)));
    }
  }));
  report(`${tag} poll agents=${agents.length}`, latencies, codes, t0);
}

async function turns(perMinute, seconds, tag) {
  const latencies = [];
  const codes = {};
  const t0 = Date.now();
  const end = t0 + seconds * 1000;
  const gap = 60000 / perMinute;
  const inflight = [];
  let i = 0;
  while (Date.now() < end) {
    const user = fleet.users[i % fleet.users.length];
    i += 1;
    inflight.push(call('POST', `/api/messages/${user.podId}`, user.token, { content: `loadgen ${i}: what should I work on today?` }, user.ip)
      .then((res) => { latencies.push(res.ms); codes[res.status] = (codes[res.status] || 0) + 1; }));
    await sleep(gap);
  }
  await Promise.all(inflight);
  report(`${tag} post perMin=${perMinute}`, latencies, codes, t0);
}

const tag = process.env.TAG || mode;
if (mode === 'poll') await pollers(Number(a1), Number(a2), tag);
if (mode === 'turns') await turns(Number(a1), Number(a2), tag);
if (mode === 'mix') await Promise.all([pollers(Number(a1), Number(a3), tag), turns(Number(a2), Number(a3), tag)]);
process.exit(0);
