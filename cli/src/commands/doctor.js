/**
 * commonly doctor — one line per check, exit 1 when any fails (TASK-660).
 * The checks live in ../lib/doctor.js; this file supplies the real host.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { createClient } from '../lib/api.js';
import { getToken, resolveInstance, resolveInstanceUrl } from '../lib/config.js';
import { loadDaemonRecord } from '../lib/daemon-store.js';
import { servicePaths } from '../lib/daemon-service.js';
import { getAdapter } from '../lib/adapters/index.js';
import { detectSeatbelt } from '../lib/sandbox/seatbelt.js';
import { daemonStatusErrorMessage, getDaemonMachineStatus } from './daemon.js';
import { listLocalAgents } from './agent.js';
import { doctorExitCode, formatDoctorLine, runDoctor } from '../lib/doctor.js';

const REQUEST_TIMEOUT_MS = 5000;

// Every server read doctor makes is bounded, so a hung instance is a fail line, not a hang.
const timedClient = (client) => ({
  ...client,
  get: (path, params = {}, options = {}) => client.get(path, params, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...options }),
});

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const isExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Node refuses to spawn a .cmd without a shell (CVE-2024-27980), and npm's
// Windows shim is a .cmd, so that one case goes through cmd.exe, quoted.
export const versionCommand = (binary, platform = process.platform) => (
  platform === 'win32' && /\.(cmd|bat)$/i.test(binary)
    ? { command: `"${binary}" --version`, args: [], shell: true }
    : { command: binary, args: ['--version'], shell: false }
);

const runVersion = (binary) => {
  const { command, args, shell } = versionCommand(binary);
  const res = spawnSync(command, args, { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS, shell });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim().split(/\s+/)[0] || null;
};

/**
 * The instance and token every other command would use for `instanceArg`:
 * createClient's own resolution (api.js), so doctor cannot pass a login that
 * `agent attach` then fails, or fail one that works. COMMONLY_TOKEN wins over
 * the saved token there, so it wins here, and the line says which one it sent.
 */
export const loginTarget = ({
  instanceArg = null,
  env = process.env,
  resolve = resolveInstance,
  resolveUrl = resolveInstanceUrl,
  tokenFor = getToken,
} = {}) => {
  const saved = resolve(instanceArg);
  const token = tokenFor(instanceArg);
  return {
    key: saved?.key || null,
    url: resolveUrl(instanceArg),
    tokenSource: !token ? null : (env.COMMONLY_TOKEN ? 'env' : 'saved'),
    loginHint: instanceArg ? `commonly login --instance ${instanceArg}` : 'commonly login',
  };
};

export const hostDoctorDeps = ({ instance: instanceArg = null } = {}) => ({
  listAgents: () => listLocalAgents(),
  getAdapter,
  node: { nodeVersion: process.versions.node, enginesRange: pkg.engines?.node },
  install: {
    pathValue: process.env.PATH,
    platform: process.platform,
    isExecutable,
    runVersion,
    runningVersion: pkg.version,
  },
  login: {
    target: loginTarget({ instanceArg }),
    fetchUser: () => timedClient(createClient({ instance: instanceArg })).get('/api/auth/user'),
  },
  daemon: {
    loadRecord: loadDaemonRecord,
    serviceFile: servicePaths().file,
    fileExists: existsSync,
    fetchMachine: (record) => getDaemonMachineStatus({
      client: timedClient(createClient({ instance: record.instanceUrl, token: record.daemonToken })),
      record,
    }),
    describeError: daemonStatusErrorMessage,
    now: Date.now(),
  },
  macos: {
    platform: process.platform,
    detectSeatbelt,
    isFile,
    loginKeychainPath: join(homedir(), 'Library', 'Keychains', 'login.keychain-db'),
  },
});

export const registerDoctor = (program) => {
  program
    .command('doctor')
    .description('Check this computer: Node, the install, login, the daemon, adapter CLIs, macOS prerequisites')
    .option('--instance <keyOrUrl>', 'Saved instance to check the login of (default: the active one)')
    .action(async (opts) => {
      try {
        const results = await runDoctor(hostDoctorDeps({ instance: opts.instance || null }));
        for (const line of results.map(formatDoctorLine)) console.log(line);
        process.exitCode = doctorExitCode(results);
      } catch (error) {
        console.error(`commonly doctor could not finish: ${error.message}`);
        process.exitCode = 1;
      }
    });
};
