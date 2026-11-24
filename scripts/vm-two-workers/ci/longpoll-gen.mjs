// F597 comparison: idle BYO agents polling with and without the long-poll.
// Runs with node 22 (the backend image), against API, on a fleet that
// loadgen.mjs setup wrote to $STATE/fleet.json.
//   node longpoll-gen.mjs idle <agents> <seconds> <waitMs>
//   node longpoll-gen.mjs trickle <agents> <postsPerMinute> <seconds> <waitMs>
// Every agent runs the CLI's loop (cli/src/lib/poller.js + long-poll.js): it
// asks for a hold of waitMs; an empty answer that took at least half of that
// was held, so it polls again at once, and anything else waits out the normal
// 5 s interval. Against a server without the long-poll the same client
// therefore polls every 5 s, as today.
// Prints one RESULT line per phase.
import fs from 'node:fs';

const API = process.env.API;
const STATE = process.env.STATE || '/state';
const TAG = process.env.TAG || 'longpoll';
if (!API) throw new Error('set API, e.g. http://backend:5000');
const INTERVAL_MS = 5000;
const RAMP_MS = 30000;

const headers = (token, ip) => ({
  'Content-Type': 'application/json',
  'User-Agent': 'commonly-loadgen/1',
  'X-Forwarded-For': ip,
  'CF-Connecting-IP': ip,
  Authorization: `Bearer ${token}`,
});

async function call(method, path, token, ip, body) {
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

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const fleet = JSON.parse(fs.readFileSync(`${STATE}/fleet.json`, 'utf8'));

async function pollers(count, seconds, waitMs, onEvent) {
  const t0 = Date.now();
  const from = t0 + RAMP_MS;
  const end = t0 + seconds * 1000;
  const stats = { n: 0, held: 0, all: [], quick: [], codes: {} };
  const agents = fleet.agents.slice(0, count);
  await Promise.all(agents.map(async (agent) => {
    await sleep(Math.random() * INTERVAL_MS);
    while (Date.now() < end) {
      const started = Date.now();
      const query = `agentName=${agent.name}&instanceId=default&limit=10${waitMs > 0 ? `&waitMs=${waitMs}` : ''}`;
      const res = await call('GET', `/api/agents/runtime/events?${query}`, agent.token, agent.ip);
      const events = Array.isArray(res.json.events) ? res.json.events : [];
      const held = waitMs > 0 && res.status === 200 && !events.length && res.ms >= waitMs / 2;
      if (started >= from && started < end) {
        stats.n += 1;
        stats.all.push(res.ms);
        if (held) stats.held += 1; else stats.quick.push(res.ms);
        stats.codes[res.status] = (stats.codes[res.status] || 0) + 1;
      }
      for (const event of events) onEvent?.(event);
      if (!held) await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)));
    }
  }));
  const windowS = (end - from) / 1000;
  const bad = Object.entries(stats.codes).filter(([code]) => !/^2/.test(code)).reduce((s, [, c]) => s + c, 0);
  return {
    agents: agents.length,
    perAgentHour: ((stats.n / agents.length / windowS) * 3600).toFixed(0),
    rps: (stats.n / windowS).toFixed(1),
    held: stats.held,
    n: stats.n,
    p50: percentile(stats.all, 50).toFixed(0),
    p95: percentile(stats.all, 95).toFixed(0),
    quickP95: percentile(stats.quick, 95).toFixed(0),
    err: ((100 * bad) / Math.max(stats.n, 1)).toFixed(2),
    codes: JSON.stringify(stats.codes),
  };
}

const line = (label, r, extra = '') => console.log(
  `RESULT ${TAG} ${label} agents=${r.agents} n=${r.n} rps=${r.rps} perAgentHour=${r.perAgentHour} held=${r.held} `
  + `p50=${r.p50}ms p95=${r.p95}ms quickP95=${r.quickP95}ms err=${r.err}% codes=${r.codes}${extra}`,
);

const [, , mode, a1, a2, a3, a4] = process.argv;
if (mode === 'idle') {
  line('idle', await pollers(Number(a1), Number(a2), Number(a3)));
}
if (mode === 'trickle') {
  const count = Number(a1);
  const perMinute = Number(a2);
  const seconds = Number(a3);
  const waitMs = Number(a4);
  // Posts go only to pods whose agents are polling; each names its send time,
  // and every agent that receives it records how long delivery took.
  const users = fleet.users.slice(0, Math.max(1, Math.ceil(count / (fleet.agents.length / fleet.users.length))));
  const delivery = [];
  const onEvent = (event) => {
    const sent = /lgsent=(\d{13})/.exec(JSON.stringify(event));
    if (sent) delivery.push(Date.now() - Number(sent[1]));
  };
  const posting = (async () => {
    const t0 = Date.now();
    const stopAt = t0 + (seconds - 10) * 1000;
    let i = 0;
    await sleep(RAMP_MS);
    while (Date.now() < stopAt) {
      const user = users[i % users.length];
      i += 1;
      call('POST', `/api/messages/${user.podId}`, user.token, user.ip, { content: `loadgen ${i} lgsent=${Date.now()}` });
      await sleep(60000 / perMinute);
    }
    return i;
  })();
  const [r, posts] = await Promise.all([pollers(count, seconds, waitMs, onEvent), posting]);
  line('trickle', r, ` posts=${posts} delivered=${delivery.length} deliveryP50=${percentile(delivery, 50).toFixed(0)}ms deliveryP95=${percentile(delivery, 95).toFixed(0)}ms`);
}
process.exit(0);
