// Real-process helpers for the kill tests.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// A zombie still answers kill(pid, 0); on Linux it is read as gone, because a
// SIGKILLed orphan waits there until init reaps it.
export const isRunning = (pid) => {
  try { process.kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};

export const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return predicate();
};

/** The comma-separated pids a process wrote to `file`, once it has written them. */
export const readPids = async (file, count = 1) => {
  const ready = () => existsSync(file) && new RegExp(`^\\d+(,\\d+){${count - 1}}\\s*$`).test(readFileSync(file, 'utf8'));
  assert.ok(await waitFor(ready), `no ${count} pid(s) in ${file}`);
  return readFileSync(file, 'utf8').trim().split(',').map(Number);
};

export const readPid = async (file) => (await readPids(file, 1))[0];

export const reap = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
