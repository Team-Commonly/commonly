#!/usr/bin/env node
/**
 * Startup CPU: user+sys CPU a broker spends from exec to answering its first
 * `initialize`, then exiting on SIGTERM, as reported by zsh's `time` (getrusage of
 * the child, microsecond resolution; /usr/bin/time only prints 10 ms steps). On a
 * contended machine wall-clock cold start mostly measures the scheduler; CPU
 * time measures the work, so it is the steadier of the two. Round-robin.
 *
 * Usage: node bench/startcpu.js <runs> '<json: [[label, cmd, ...args], ...]>'
 */
import { spawn, spawnSync } from 'node:child_process';
import { brokerEnv, freePort, median, post, sleep, writeConfig } from './common.js';

const RUNS = Number(process.argv[2] || 15);
const specs = JSON.parse(process.argv[3]);
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

const once = async (cmd) => {
  const port = await freePort();
  const { path } = writeConfig({ port, upstreamUrl: 'http://127.0.0.1:9/mcp' });
  const timed = spawn('zsh', ['-c', 'TIMEFMT="cpu %uU %uS maxrss %MKB"; time "$@"', 'zsh', ...cmd, '--config', path], {
    env: brokerEnv(), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  timed.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => timed.once('exit', r));
  for (;;) {
    try { if ((await post(port, INIT)).status === 200) break; } catch { /* starting */ }
    await sleep(1);
  }
  spawnSync('pkill', ['-TERM', '-P', String(timed.pid)]);
  await exited;
  const m = /cpu (\d+)us (\d+)us maxrss (\d+)KB/.exec(err);
  if (!m) throw new Error(`no timing line: ${err}`);
  return { cpuMs: (Number(m[1]) + Number(m[2])) / 1000, peakMB: Number(m[3]) / 1024 };
};

const out = Object.fromEntries(specs.map(([label]) => [label, []]));
for (let i = 0; i < RUNS; i += 1) {
  for (const [label, ...cmd] of specs) out[label].push(await once(cmd));
}
for (const [label] of specs) {
  const xs = out[label];
  const cpu = xs.map((x) => x.cpuMs);
  console.log(JSON.stringify({
    label, runs: RUNS,
    startupCpuMsMedian: Math.round(median(cpu) * 10) / 10, startupCpuMsMin: Math.round(Math.min(...cpu) * 10) / 10,
    startupPeakRssMBMedian: Math.round(median(xs.map((x) => x.peakMB)) * 10) / 10,
  }));
}
