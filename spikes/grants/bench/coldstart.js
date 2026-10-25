#!/usr/bin/env node
/**
 * Cold start: wall time from spawn() to the first 200 answer to `initialize`,
 * polled on fresh connections every ~1 ms. The commands are run round-robin,
 * one spawn each per round, so contention from other work on the machine lands
 * on every implementation alike. `initialize` never contacts the upstream, so
 * none is started.
 *
 * Usage: node bench/coldstart.js <runs> '<json: [[label, cmd, ...args], ...]>'
 * Prints one JSON line per label: {label, runs, medianMs, p90Ms, minMs, maxMs, loadavg1, samples}.
 */
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { brokerEnv, freePort, median, post, quantile, sleep, writeConfig } from './common.js';

const RUNS = Number(process.argv[2] || 30);
const specs = JSON.parse(process.argv[3]);
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } };

const once = async (cmd) => {
  const port = await freePort();
  const { path } = writeConfig({ port, upstreamUrl: 'http://127.0.0.1:9/mcp' });
  const started = process.hrtime.bigint();
  const child = spawn(cmd[0], [...cmd.slice(1), '--config', path], { env: brokerEnv(), stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  let ms;
  for (;;) {
    try {
      const res = await post(port, INIT);
      if (res.status === 200 && JSON.parse(res.body).result?.serverInfo) {
        ms = Number(process.hrtime.bigint() - started) / 1e6;
        break;
      }
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`broker exited ${child.exitCode}`);
    await sleep(1);
  }
  child.kill('SIGKILL');
  await exited;
  return ms;
};

const samples = Object.fromEntries(specs.map(([label]) => [label, []]));
const loads = [];
for (const [, ...cmd] of specs) await once(cmd); // first exec of each binary: not counted
for (let i = 0; i < RUNS; i += 1) {
  loads.push(loadavg()[0]);
  for (const [label, ...cmd] of specs) samples[label].push(await once(cmd));
}
const r = (x) => Math.round(x * 10) / 10;
for (const [label] of specs) {
  const s = samples[label];
  const sorted = [...s].sort((a, b) => a - b);
  console.log(JSON.stringify({
    label, runs: RUNS, medianMs: r(median(s)), p90Ms: r(quantile(sorted, 0.9)), minMs: r(sorted[0]), maxMs: r(sorted.at(-1)),
    loadavg1: r(median(loads)), samples: s.map(r),
  }));
}
