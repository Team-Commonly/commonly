import { describe, test, expect } from '@jest/globals';
import { mkdtemp, readFile, writeFile, chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireLock, ciImages, selectSuite, validatePolicy, limits } from '../../scripts/container-tests/run.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sample = (lockPath) => ({ lockPath, nodeMemory: '2g', serviceMemory: '1g', cpus: 1, serviceCpus: 1,
  workTmpfs: '1g', tempTmpfs: '128m', homeTmpfs: '128m', serviceTmpfs: '256m', logMaxSize: '1m', logMaxFiles: 1 });
const usingTemp = async (fn) => {
  const dir = await mkdtemp(resolve(tmpdir(), 'container-runner-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
const fakeTools = async (dir) => {
  const bin = resolve(dir, 'bin'); await mkdir(bin);
  for (const name of ['docker', 'git']) {
    const path = resolve(bin, name);
    await writeFile(path, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (${JSON.stringify(name)} === 'git') { process.stdout.write('package.json\\0'); process.exit(0); }
fs.appendFileSync(process.env.TRACE, JSON.stringify(args)+'\\n');
if (args[0] === 'pull' && process.env.FAIL_PULL) process.exit(17);
if (args[0] === 'image') process.stdout.write('sha256:'+args.at(-1).split(':')[0]);
if (args[0] === 'inspect') process.stdout.write('healthy');
if (args[0] === 'rm' && process.env.FAIL_CLEANUP) process.exit(1);
if (args[0] === 'ps') process.stdout.write('container-id');
if (args[0] === 'run' && args.includes('bash')) process.exit(Number(process.env.SUITE_EXIT || 0));
`);
    await chmod(path, 0o700);
  }
  return bin;
};
const invoke = async (dir, suite, extra = {}) => {
  const policyFile = resolve(dir, 'policy.json');
  await writeFile(policyFile, JSON.stringify(sample(resolve(dir, 'lock'))));
  const bin = await fakeTools(dir);
  const result = spawnSync(process.execPath, [resolve(checkout, 'scripts/container-tests/run.mjs'), suite], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: resolve(dir, 'trace'), COMMONLY_TEST_CONTAINER_POLICY: policyFile, ...extra },
    encoding: 'utf8', timeout: 15000,
  });
  const trace = (await readFile(resolve(dir, 'trace'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { result, trace };
};

describe('container test runner boundaries', () => {
  test('uses CI image tags and refuses conflicting versions', async () => {
    const workflow = await readFile(resolve(checkout, '.github/workflows/tests.yml'), 'utf8');
    expect(ciImages(workflow)).toEqual({ node: 'node:22', postgres: 'postgres:16', mongo: 'mongo:7' });
    expect(() => ciImages(`${workflow}\nnode-version: '24'`)).toThrow('disagree');
  });
  test('requires every SRE limit before execution', () => {
    expect(() => validatePolicy({})).toThrow('lockPath');
    for (const key of Object.keys(sample('/tmp/test-lock'))) {
      const policy = sample('/tmp/test-lock'); delete policy[key];
      expect(() => validatePolicy(policy)).toThrow();
    }
    expect(limits(validatePolicy(sample('/tmp/test-lock')), '2g')).toEqual(expect.arrayContaining([
      '--read-only', '--memory', '2g', '--memory-swap', '--cpus', '1', '--log-driver', 'json-file', 'max-size=1m', 'max-file=1',
    ]));
  });
  test('selects exact Jest files and refuses traversal or arbitrary commands', () => {
    expect(selectSuite(['backend/__tests__/service/foo.test.js'])).toEqual({ suite: 'backend', integration: true, path: '__tests__/service/foo.test.js' });
    for (const input of ['../../oops', 'cli/../backend/a.test.js', '--privileged', 'backend;echo hacked', '/tmp/a.test.js']) {
      expect(() => selectSuite([input])).toThrow();
    }
    expect(() => selectSuite(['cli', '--watch'])).toThrow();
  });
  test('lock contention waits for the active owner, then acquires', async () => usingTemp(async (dir) => {
    const path = resolve(dir, 'lock'); const release = await acquireLock(path);
    let waits = 0;
    const nextRelease = await acquireLock(path, { wait: async () => { waits += 1; await release(); } });
    expect(waits).toBe(1);
    expect(Number(await readFile(resolve(path, 'pid'), 'utf8'))).toBe(process.pid);
    await nextRelease();
  }));
  test('dead PID is the only automatic stale-lock recovery', async () => usingTemp(async (dir) => {
    const path = resolve(dir, 'lock'); await mkdir(path); await writeFile(resolve(path, 'pid'), '2147483647');
    const release = await acquireLock(path, { alive: () => false });
    expect(Number(await readFile(resolve(path, 'pid'), 'utf8'))).toBe(process.pid); await release();
  }));
  test('propagates suite exit and isolates all writes without building or host dependency mounts', async () => usingTemp(async (dir) => {
    const { result, trace } = await invoke(dir, 'cli', { SUITE_EXIT: '37' });
    expect(result.status).toBe(37);
    expect(trace[0]).toEqual(['pull', 'node:22']);
    const run = trace.find((args) => args[0] === 'run');
    expect(run).toEqual(expect.arrayContaining(['--rm', '--pull=never', '--read-only', `type=bind,src=${checkout},dst=/source,readonly`, '/work:rw,exec,size=1g', '/home/test:rw,exec,size=128m']));
    expect(trace.some((args) => args.includes('build') || args.includes('-p') || args.includes('--privileged'))).toBe(false);
    expect(run.filter((arg) => arg.startsWith('type=bind'))).toHaveLength(1);
    await expect(readFile(resolve(dir, 'lock/pid'))).rejects.toThrow();
  }));
  test('pull failure runs no container and releases the lock', async () => usingTemp(async (dir) => {
    const { result, trace } = await invoke(dir, 'backend', { FAIL_PULL: '1' });
    expect(result.status).toBe(1); expect(trace.some((args) => args[0] === 'run')).toBe(false);
    await expect(readFile(resolve(dir, 'lock/pid'))).rejects.toThrow();
  }));
  test('service mode pulls CI databases, publishes no ports and cleans its private network', async () => usingTemp(async (dir) => {
    const { result, trace } = await invoke(dir, 'service');
    expect(result.status).toBe(0);
    expect(trace.filter((args) => args[0] === 'pull').map((args) => args[1])).toEqual(['node:22', 'postgres:16', 'mongo:7']);
    expect(trace.filter((args) => args[0] === 'run')).toHaveLength(3);
    expect(trace.filter((args) => args[0] === 'run').every((args) => args.includes('--read-only') && args.includes('--memory') && args.includes('--rm') && !args.includes('-p'))).toBe(true);
    expect(trace.at(-1).slice(0, 2)).toEqual(['network', 'rm']);
  }));
  test('failed cleanup retains the global lock', async () => usingTemp(async (dir) => {
    const { result } = await invoke(dir, 'cli', { FAIL_CLEANUP: '1' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('lock retained');
    expect(Number(await readFile(resolve(dir, 'lock/pid'), 'utf8'))).toBeGreaterThan(0);
  }));
});
