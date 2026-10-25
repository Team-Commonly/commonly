#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const size = /^[1-9]\d*[kmg]$/i;
export function validatePolicy(value) {
  if (!value || !isAbsolute(value.lockPath || '') || value.lockPath === '/') throw new Error('SRE policy needs an absolute lockPath');
  for (const key of ['nodeMemory', 'serviceMemory', 'workTmpfs', 'tempTmpfs', 'homeTmpfs', 'serviceTmpfs', 'logMaxSize']) {
    if (!size.test(value[key] || '')) throw new Error(`SRE policy needs ${key} (positive k/m/g size)`);
  }
  if (!(value.cpus > 0 && value.cpus <= 64 && value.serviceCpus > 0 && value.serviceCpus <= 64) || !Number.isInteger(value.logMaxFiles) || value.logMaxFiles < 1 || value.logMaxFiles > 10) {
    throw new Error('SRE policy needs positive cpus (<=64) and logMaxFiles (1..10)');
  }
  return value;
}
export function selectSuite(args) {
  if (args.length !== 1) throw new Error('Usage: npm run test:container -- backend|cli|frontend|service|<repo-relative Jest file>');
  const name = args[0];
  if (['backend', 'cli', 'frontend', 'service'].includes(name)) return { suite: name === 'service' ? 'backend' : name, integration: name === 'service', path: '' };
  const match = /^(backend|cli|frontend)\/(.+\.(?:test|spec)\.[cm]?[jt]sx?)$/.exec(name);
  if (!match || name.split('/').some((part) => part === '..' || part === '.')) throw new Error('Expected a suite or a repo-relative Jest test file');
  return { suite: match[1], integration: name.startsWith('backend/__tests__/service/'), path: match[2] };
}
export function ciImages(workflow) {
  const versions = [...workflow.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => m[1]);
  const tags = (name) => [...new Set([...workflow.matchAll(new RegExp(`image: (${name}:[\\w.-]+)`, 'g'))].map((m) => m[1]))];
  if (!versions.length || new Set(versions).size !== 1) throw new Error('CI Node versions disagree');
  const postgres = tags('postgres'); const mongo = tags('mongo');
  if (postgres.length !== 1 || mongo.length !== 1) throw new Error('CI database image tags disagree or are missing');
  return { node: `node:${versions[0]}`, postgres: postgres[0], mongo: mongo[0] };
}
export function limits(policy, memory, cpus = policy.cpus) {
  return ['--read-only', '--memory', memory, '--memory-swap', memory, '--cpus', String(cpus),
    '--pids-limit', '512', '--log-driver', 'json-file', '--log-opt', `max-size=${policy.logMaxSize}`,
    '--log-opt', `max-file=${policy.logMaxFiles}`, '--tmpfs', `/tmp:rw,exec,size=${policy.tempTmpfs}`];
}
function command(program, args, { input, capture = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'] });
    const chunks = [];
    if (capture) child.stdout.on('data', (data) => chunks.push(data));
    child.on('error', reject);
    child.on('close', (code, signal) => accept({ code: code ?? (signal === 'SIGINT' ? 130 : 143), output: Buffer.concat(chunks).toString() }));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
async function checked(program, args, options) {
  const result = await command(program, args, options);
  if (result.code !== 0) throw new Error(`${program} ${args[0]} failed (${result.code})`);
  return result.output.trim();
}
export async function acquireLock(path, { onStale = async () => {}, wait = () => new Promise((done) => setTimeout(done, 1000)),
  alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } },
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Re-read under a recovery mutex: two waiters must never remove a new owner.
    let recovering = false;
    try {
      await mkdir(`${path}.reap`); recovering = true;
      const pid = Number((await readFile(resolve(path, 'pid'), 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
        await onStale(pid);
        await rm(path, { recursive: true });
        continue;
      }
    } catch (error) {
      if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
    } finally { if (recovering) await rm(`${path}.reap`, { recursive: true, force: true }); }
    await wait();
  }
  try { await writeFile(resolve(path, 'pid'), String(process.pid), { mode: 0o600 }); }
  catch (error) { await rm(path, { recursive: true }); throw error; }
  return () => rm(path, { recursive: true });
}

async function sourceManifest() {
  const result = await checked('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { capture: true });
  const entries = [];
  for (const path of new Set(result.split('\0').filter(Boolean))) {
    if (path.split('/').some((part) => ['node_modules', '.git', 'dist', 'coverage', '.dev'].includes(part))) continue;
    const info = await lstat(resolve(root, path)).catch(() => null);
    if (info && !info.isDirectory()) entries.push(path);
  }
  return Buffer.from(`${entries.join('\0')}\0`);
}
export async function main(args) {
  const target = selectSuite(args);
  if (target.path) {
    const file = await realpath(resolve(root, target.suite, target.path));
    if (relative(root, file).startsWith('..')) throw new Error('Test path escapes the checkout');
  }
  const policyPath = process.env.COMMONLY_TEST_CONTAINER_POLICY || resolve(homedir(), '.commonly/test-container-policy.json');
  let policy;
  try { policy = validatePolicy(JSON.parse(await readFile(policyPath, 'utf8'))); }
  catch (error) { throw new Error(`SRE policy unavailable/invalid at ${policyPath}: ${error.message}. Request approved caps and lockPath on TASK-507.`); }
  const images = ciImages(await readFile(resolve(root, '.github/workflows/tests.yml'), 'utf8'));
  if (root.includes(',')) throw new Error('Docker source mount requires a checkout path without commas');
  const release = await acquireLock(policy.lockPath, { onStale: async (pid) => {
    const filter = `label=commonly.test.pid=${pid}`;
    const names = await checked('docker', ['ps', '-aq', '--filter', filter], { capture: true });
    if (names) await checked('docker', ['rm', '-f', ...names.split(/\s+/)], { capture: true });
    const networks = await checked('docker', ['network', 'ls', '-q', '--filter', filter], { capture: true });
    if (networks) await checked('docker', ['network', 'rm', ...networks.split(/\s+/)], { capture: true });
  } });
  const id = `commonly-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  const containers = []; let network = false; let cleaning;
  const cleanup = () => {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      let failed = false;
      for (const name of containers.reverse()) {
        const remaining = await command('docker', ['ps', '-a', '--format', '{{.ID}}', '--filter', `name=^${name}$`], { capture: true });
        if (remaining.code) failed = true;
        else if (remaining.output.trim() && (await command('docker', ['rm', '-f', name], { capture: true })).code) failed = true;
      }
      if (network && (await command('docker', ['network', 'rm', id], { capture: true })).code) failed = true;
      if (failed) throw new Error(`Cleanup incomplete; lock retained at ${policy.lockPath}. Ask SRE to inspect ${id}.`);
      await release();
    })();
    return cleaning;
  };
  const onSignal = async (signal) => {
    try { await cleanup(); } catch (error) { console.error(error.message); }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupt = () => { void onSignal('SIGINT'); }; const terminate = () => { void onSignal('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const needed = target.integration ? ['node', 'postgres', 'mongo'] : ['node'];
    const pulled = {};
    for (const key of needed) {
      await checked('docker', ['pull', images[key]]);
      pulled[key] = await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', images[key]], { capture: true });
    }
    if (target.integration) {
      await checked('docker', ['network', 'create', '--label', `commonly.test.pid=${process.pid}`, '--label', 'commonly.test=1', id], { capture: true }); network = true;
      for (const key of ['postgres', 'mongo']) {
        const name = `${id}-${key}`; containers.push(name);
        const dbArgs = key === 'postgres'
          ? ['--tmpfs', `/var/lib/postgresql/data:rw,size=${policy.serviceTmpfs}`, '--tmpfs', `/var/run/postgresql:rw,size=${policy.tempTmpfs}`, '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=commonly-test', '--health-cmd', 'pg_isready -h 127.0.0.1 -U postgres']
          : ['--tmpfs', `/data/db:rw,size=${policy.serviceTmpfs}`, '--tmpfs', `/data/configdb:rw,size=${policy.serviceTmpfs}`, '--ulimit', 'nofile=64000:64000', '--health-cmd', 'mongosh --quiet --eval "db.runCommand({ping:1}).ok"'];
        await checked('docker', ['run', '--rm', '--pull=never', '-d', '--name', name, '--label', 'commonly.test=1', '--label', `commonly.test.pid=${process.pid}`, '--network', id, '--network-alias', key,
          ...limits(policy, policy.serviceMemory, policy.serviceCpus), ...dbArgs, '--health-interval', '1s', '--health-timeout', '5s', '--health-retries', '60', pulled[key]], { capture: true });
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const state = await checked('docker', ['inspect', '--format', '{{.State.Health.Status}}', name], { capture: true });
          if (state === 'healthy') { ready = true; break; }
          if (state === 'unhealthy') break;
          await new Promise((done) => setTimeout(done, 1000));
        }
        if (!ready) throw new Error(`${key} failed its readiness check`);
      }
    }
    const name = `${id}-node`; containers.push(name);
    const result = await command('docker', ['run', '--rm', '--pull=never', '-i', '--name', name, '--label', 'commonly.test=1', '--label', `commonly.test.pid=${process.pid}`,
      ...limits(policy, policy.nodeMemory), ...(network ? ['--network', id] : []),
      '--mount', `type=bind,src=${root},dst=/source,readonly`,
      '--tmpfs', `/work:rw,exec,size=${policy.workTmpfs}`, '--tmpfs', `/home/test:rw,exec,size=${policy.homeTmpfs}`,
      '-e', 'HOME=/home/test', '-e', 'TMPDIR=/tmp', '-e', 'npm_config_cache=/home/test/.npm', '-e', 'XDG_CACHE_HOME=/home/test/.cache',
      pulled.node, 'bash', '/source/scripts/container-tests/inside.sh', target.suite, target.path, String(target.integration)], { input: await sourceManifest() });
    return result.code;
  } finally {
    await cleanup(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
