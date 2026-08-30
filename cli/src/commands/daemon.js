/**
 * commonly daemon <subcommand>
 *
 * Phase 2, slice 1: register one machine, persist its scoped daemon bearer,
 * and report/send heartbeats. Adoption and supervision deliberately arrive in
 * later slices; this command never reads an agent runtime credential.
 */

import { hostname, homedir } from 'os';
import { spawn } from 'child_process';
import {
  existsSync, mkdirSync, openSync, rmSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { createClient } from '../lib/api.js';
import { getToken, resolveInstanceUrl } from '../lib/config.js';
import { loadDaemonRecord, removeDaemonRecord, saveDaemonRecord } from '../lib/daemon-store.js';
import {
  createDaemonSupervisor,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_POLL_MS,
} from '../lib/daemon-supervisor.js';
import { loadAgentToken, saveAgentToken } from './agent.js';
import { getAdapter } from '../lib/adapters/index.js';
import {
  installDaemonService,
  uninstallDaemonService,
} from '../lib/daemon-service.js';

const requireDaemonRecord = () => {
  const record = loadDaemonRecord();
  if (!record) {
    throw new Error('No local daemon is registered. Run: commonly daemon register');
  }
  return record;
};

const requireUserToken = (instance) => {
  const token = getToken(instance);
  if (!token) throw new Error(`Not logged in to ${instance}. Run: commonly login --instance ${instance}`);
  return token;
};

const requireRegistrationResponse = (response) => {
  const machine = response?.machine;
  if (!machine?.id || !machine?.machineId || !machine?.name || !response?.daemonToken) {
    throw new Error('Server returned an incomplete machine registration. No daemon credential was stored.');
  }
  return { machine, daemonToken: response.daemonToken };
};

// Exported for a service-level test: persistence failure must revoke the
// freshly-created machine because the raw bearer is not recoverable later.
export const registerDaemonMachine = async ({
  client,
  instanceUrl,
  name,
  persist = saveDaemonRecord,
}) => {
  const { machine, daemonToken } = requireRegistrationResponse(
    await client.post('/api/machines', { name }),
  );
  const record = {
    machineDbId: machine.id,
    machineId: machine.machineId,
    machineName: machine.name,
    instanceUrl,
    daemonToken,
    registeredAt: new Date().toISOString(),
  };

  try {
    persist(record);
  } catch (error) {
    // The token is a one-time response. If it cannot be secured locally, tear
    // down the server row so it cannot remain a live, unrecoverable bearer.
    try {
      await client.del(`/api/machines/${machine.id}`);
    } catch (revokeError) {
      throw new Error(
        `Could not store the daemon credential and could not revoke machine ${machine.name} (${machine.id}): ${revokeError.message}`,
      );
    }
    throw new Error(`Could not store the daemon credential securely: ${error.message}. Machine registration was revoked.`);
  }

  return { machine, record };
};

export const heartbeatDaemonMachine = async ({ client, record }) => (
  client.post(`/api/machines/${record.machineDbId}/heartbeat`)
);

export const getDaemonMachineStatus = async ({ client }) => {
  const response = await client.get('/api/machines/me');
  return response?.machine || null;
};

// Revoke remotely before unlinking locally. A failed network call must leave
// the bearer record intact so the operator can retry rather than orphaning a
// year-long daemon credential they can no longer address from the CLI.
export const unregisterDaemonMachine = async ({ client, record, remove = removeDaemonRecord }) => {
  try {
    await client.del(`/api/machines/${record.machineDbId}`);
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  remove();
};

// The adapter names a binary on THIS machine — the one fact the server cannot
// know (same reasoning as `agent run`'s env bootstrap). A server-declared
// preference is honored when that CLI is installed; otherwise probe the known
// ones in order.
export const resolveAdapterForRuntime = async (runtime, registry = { getAdapter }) => {
  const candidates = [runtime?.adapter, 'claude', 'codex'].filter(Boolean);
  for (const name of candidates) {
    const adapter = registry.getAdapter(name);
    // eslint-disable-next-line no-await-in-loop
    if (adapter && await adapter.detect()) return name;
  }
  return null;
};

export const registerDaemon = (program) => {
  const daemon = program.command('daemon').description('Manage the local Commonly daemon');

  daemon.addHelpText('after', `
The daemon token is scoped to this machine and stored in a 0600 file under
~/.commonly/daemon/. It is never shown again after registration.

Examples:
  $ commonly daemon register --name "Sam's MacBook"
  $ commonly daemon heartbeat
  $ commonly daemon status
  $ commonly daemon unregister
`);

  daemon
    .command('register')
    .description('Register this machine and securely store its daemon credential')
    .option('--name <name>', 'Machine name (default: this computer\'s hostname)')
    .option('--instance <url-or-key>', 'Target Commonly instance')
    .action(async (opts) => {
      try {
        const existing = loadDaemonRecord();
        if (existing) {
          throw new Error(`A local daemon is already registered for ${existing.machineName}. Run: commonly daemon status`);
        }
        const instanceUrl = resolveInstanceUrl(opts.instance);
        const client = createClient({ instance: instanceUrl, token: requireUserToken(opts.instance || instanceUrl) });
        const { machine, record } = await registerDaemonMachine({
          client,
          instanceUrl,
          name: String(opts.name || hostname()).trim(),
        });
        console.log(`Registered ${machine.name}. Daemon credential stored securely.`);

        try {
          await heartbeatDaemonMachine({
            client: createClient({ instance: record.instanceUrl, token: record.daemonToken }),
            record,
          });
          console.log('Initial heartbeat accepted.');
        } catch (error) {
          console.error(`Machine is registered, but its initial heartbeat failed: ${error.message}`);
          console.error('Retry with: commonly daemon heartbeat');
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(`Daemon registration failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  daemon
    .command('unregister')
    .description('Revoke this machine on the server and remove its local daemon credential')
    .action(async () => {
      try {
        const record = requireDaemonRecord();
        const client = createClient({
          instance: record.instanceUrl,
          token: requireUserToken(record.instanceUrl),
        });
        await unregisterDaemonMachine({ client, record });
        console.log(`Unregistered ${record.machineName} and removed its local daemon credential.`);
      } catch (error) {
        console.error(`Daemon unregister failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  daemon
    .command('heartbeat')
    .description('Send a machine liveness heartbeat using the stored daemon credential')
    .action(async () => {
      try {
        const record = requireDaemonRecord();
        const response = await heartbeatDaemonMachine({
          client: createClient({ instance: record.instanceUrl, token: record.daemonToken }),
          record,
        });
        console.log(`Heartbeat accepted for ${response?.machine?.name || record.machineName}.`);
      } catch (error) {
        console.error(`Daemon heartbeat failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  // ── install / uninstall (ADR-026 D1) ──────────────────────────────────────
  const serviceDeps = () => ({
    writeFile: (file, content) => writeFileSync(file, content, 'utf8'),
    mkdirp: (dir) => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); },
    existsFile: (file) => existsSync(file),
    removeFile: (file) => rmSync(file),
    execCmd: (argv) => new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });
      child.on('error', rejectPromise);
      child.on('exit', (code) => (code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`${argv.join(' ')} exited ${code}`))));
    }),
    log: (line) => console.log(line),
  });

  daemon
    .command('install')
    .description('Register the daemon as a login service (launchd/systemd) so it survives reboots')
    .action(async () => {
      try {
        // A service without a credential just crash-loops at boot.
        requireDaemonRecord();
        await installDaemonService(serviceDeps());
        console.log('The daemon now starts at login and is kept alive. Uninstall with: commonly daemon uninstall');
      } catch (error) {
        console.error(`Daemon install failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  daemon
    .command('uninstall')
    .description('Remove the daemon login service (agents stop being supervised on this machine)')
    .action(async () => {
      try {
        await uninstallDaemonService(serviceDeps());
      } catch (error) {
        console.error(`Daemon uninstall failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  // ── run (ADR-026 Phase 2, slice 2) ────────────────────────────────────────
  daemon
    .command('run')
    .description('Run the resident supervisor: adopt requested agents, keep bound agents running, report per-agent state')
    .option('--poll <ms>', 'Work-list poll interval in ms', String(DEFAULT_POLL_MS))
    .option('--heartbeat <ms>', 'Heartbeat interval in ms', String(DEFAULT_HEARTBEAT_MS))
    .action(async (opts) => {
      try {
        const record = requireDaemonRecord();
        const client = createClient({ instance: record.instanceUrl, token: record.daemonToken });
        const logsDir = join(homedir(), '.commonly', 'logs', 'daemon');
        if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
        const stampLog = (line) => console.log(`${new Date().toISOString()} ${line}`);

        const supervisor = createDaemonSupervisor({
          record,
          client,
          // One child per agent, logging to its own file. The child is the
          // ordinary `commonly agent run <name>` — the daemon is its
          // supervisor, never its replacement (D6).
          spawnChild: (agentName) => {
            const out = openSync(join(logsDir, `${agentName}.log`), 'a');
            return spawn(process.execPath, [process.argv[1], 'agent', 'run', agentName], {
              stdio: ['ignore', out, out],
            });
          },
          loadToken: loadAgentToken,
          saveToken: saveAgentToken,
          resolveAdapter: (runtime) => resolveAdapterForRuntime(runtime),
          log: stampLog,
        });

        stampLog(`daemon supervising for ${record.machineName} — poll ${opts.poll}ms, heartbeat ${opts.heartbeat}ms (ctrl+c to stop)`);
        await supervisor.tick();
        await supervisor.heartbeat();
        const pollTimer = setInterval(() => supervisor.tick(), Number(opts.poll) || DEFAULT_POLL_MS);
        const heartbeatTimer = setInterval(() => supervisor.heartbeat(), Number(opts.heartbeat) || DEFAULT_HEARTBEAT_MS);
        const shutdown = () => {
          stampLog('daemon stopping — terminating supervised agents');
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          supervisor.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (error) {
        console.error(`Daemon run failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  daemon
    .command('status')
    .description('Show the server-derived liveness of this machine')
    .action(async () => {
      try {
        const record = requireDaemonRecord();
        const machine = await getDaemonMachineStatus({
          client: createClient({ instance: record.instanceUrl, token: record.daemonToken }),
        });
        if (!machine) {
          console.log(`${record.machineName}: no longer registered on the server.`);
          return;
        }
        const lastSeen = machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString() : 'never';
        console.log(`${machine.name}: ${machine.status} (last heartbeat: ${lastSeen})`);
      } catch (error) {
        console.error(`Daemon status failed: ${error.message}`);
        process.exitCode = 1;
      }
    });
};
