#!/usr/bin/env node
/**
 * Memory and throughput under load. Starts the fake upstream and a broker
 * (under /usr/bin/time -l, for the kernel's peak RSS), samples the broker's RSS
 * with `ps -o rss=` every 100 ms from a separate shell process, then runs
 * CLIENTS concurrent keep-alive clients doing `tools/call read_issue` for
 * SECONDS after a WARMUP.
 *
 * Usage: node bench/load.js <label> <clients> <seconds> -- <broker command...>
 *        node bench/load.js direct <clients> <seconds>   (clients hit the upstream itself: the ceiling)
 */
import { spawn, spawnSync } from 'node:child_process';
import { Agent } from 'node:http';
import { loadavg } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDENTIAL, brokerEnv, freePort, median, post, quantile, sleep, startUpstream, writeConfig,
} from './common.js';

const here = dirname(fileURLToPath(import.meta.url));
const sep = process.argv.indexOf('--');
const [label, clientsArg, secondsArg] = process.argv.slice(2, sep < 0 ? undefined : sep);
const cmd = sep < 0 ? [] : process.argv.slice(sep + 1);
const CLIENTS = Number(clientsArg || 32);
const SECONDS = Number(secondsArg || 30);
const WARMUP_S = 3;
const IDLE_S = 3;

const upstream = await startUpstream(here);
let port;
let token;
let broker;
let timeErr = '';
const samples = []; // {t, kb}

if (label === 'direct') {
  port = upstream.port;
  token = CREDENTIAL;
} else {
  port = await freePort();
  token = undefined; // the default grant token
  const { path } = writeConfig({ port, upstreamUrl: upstream.url });
  broker = spawn('/usr/bin/time', ['-l', ...cmd, '--config', path], { env: brokerEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  broker.stderr.on('data', (d) => { timeErr += d; });
  let pid;
  for (let i = 0; i < 500 && !pid; i += 1) {
    await sleep(10);
    pid = spawnSync('pgrep', ['-P', String(broker.pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  }
  if (!pid) throw new Error('broker child not found');
  for (;;) {
    try { if ((await post(port, { jsonrpc: '2.0', id: 0, method: 'ping' })).status === 200) break; } catch { /* starting */ }
    await sleep(5);
  }
  const sampler = spawn('sh', ['-c', `while kill -0 ${pid} 2>/dev/null; do ps -o rss= -p ${pid}; sleep 0.1; done`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  sampler.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) samples.push({ t: Date.now(), kb: Number(l.trim()) });
  });
}

const phase = (name) => ({ name, at: Date.now() });
const marks = [phase('idle')];
await sleep(IDLE_S * 1000);

const agent = new Agent({ keepAlive: true, maxSockets: CLIENTS });
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_issue', arguments: { number: 42 } } };
let completed = 0; // every call, warmup included, for CPU-per-call
const runClients = async (seconds, record) => {
  const deadline = Date.now() + seconds * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = process.hrtime.bigint();
      let ok = false;
      try {
        const res = await post(port, call, { agent, token });
        ok = res.status === 200 && res.body.includes('"result"');
      } catch { /* counted as an error */ }
      completed += 1;
      record?.(Number(process.hrtime.bigint() - t0) / 1e6, ok);
    }
  };
  await Promise.all(Array.from({ length: CLIENTS }, worker));
};

marks.push(phase('warmup'));
await runClients(WARMUP_S);
marks.push(phase('load'));
const latencies = [];
let errors = 0;
const loadStart = Date.now();
await runClients(SECONDS, (ms, ok) => { if (ok) latencies.push(ms); else errors += 1; });
const loadMs = Date.now() - loadStart;
marks.push(phase('settle'));
agent.destroy();
await sleep(IDLE_S * 1000);
marks.push(phase('end'));

const within = (a, b) => samples.filter((s) => s.t >= a && s.t < b).map((s) => s.kb);
const at = (name) => marks.find((m) => m.name === name).at;
latencies.sort((a, b) => a - b);
const mb = (kb) => (kb === undefined ? null : Math.round((kb / 1024) * 10) / 10);
const r = (x) => Math.round(x * 100) / 100;

const out = {
  label, clients: CLIENTS, seconds: SECONDS, loadavg1: Math.round(loadavg()[0]),
  calls: latencies.length, errors, rps: Math.round(latencies.length / (loadMs / 1000)),
  p50Ms: r(quantile(latencies, 0.5)), p99Ms: r(quantile(latencies, 0.99)),
};
if (broker) {
  const idle = within(at('idle') + 1000, at('warmup'));
  const load = within(at('load'), at('settle'));
  const settled = within(at('settle') + 2000, at('end'));
  // Signal the broker, not /usr/bin/time, so time survives to print its report.
  spawnSync('pkill', ['-TERM', '-P', String(broker.pid)]);
  await new Promise((resolve) => broker.once('exit', resolve));
  const peakBytes = Number(/(\d+)\s+maximum resident set size/.exec(timeErr)?.[1]);
  // CPU seconds the broker used over its whole life (startup, idle, warmup,
  // load, settle). Scheduler contention stretches wall time far more than it
  // inflates CPU time, so this is the steadier efficiency figure on a busy host.
  const cpuS = ['user', 'sys'].map((k) => Number(new RegExp(`([\\d.]+) ${k}`).exec(timeErr)?.[1])).reduce((a, b) => a + b, 0);
  Object.assign(out, {
    idleRssMB: mb(median(idle)),
    loadRssMedianMB: mb(median(load)),
    loadRssMaxSampledMB: mb(Math.max(...load)),
    settledRssMB: mb(median(settled)),
    peakRssMB_timeL: Number.isFinite(peakBytes) ? Math.round((peakBytes / 1048576) * 10) / 10 : null,
    rssSamples: samples.length,
    cpuS: Math.round(cpuS * 100) / 100,
    cpuUsPerCall: Math.round((cpuS * 1e6) / completed),
  });
}
upstream.child.kill('SIGTERM');
console.log(JSON.stringify(out));
