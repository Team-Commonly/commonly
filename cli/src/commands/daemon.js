import { collectRuntimeInventory } from '../lib/runtime-inventory.js';
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
  chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, watch,
} from 'fs';
import { createClient } from '../lib/api.js';
import { getToken, resolveInstanceUrl } from '../lib/config.js';
import {
  clearDaemonStop, loadDaemonRecord, loadDaemonStop, removeDaemonRecord,
  saveDaemonRecord, saveDaemonStop,
} from '../lib/daemon-store.js';
import {
  createDaemonSupervisor,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_POLL_MS,
} from '../lib/daemon-supervisor.js';
import { loadAgentToken, saveAgentToken } from './agent.js';
import { getLastTurn } from '../lib/session-store.js';
import { getAdapter, providerKeyEnvNames } from '../lib/adapters/index.js';
import {
  installDaemonService,
  uninstallDaemonService,
  startDaemonService,
  stopDaemonService,
  restartDaemonService,
  daemonLogPath,
  missingProviderKeys,
  servicePaths,
} from '../lib/daemon-service.js';
import { daemonLogsDir, daemonSeatLogPath, readLogTail } from '../lib/daemon-logs.js';
import { loadDaemonState, saveDaemonState } from '../lib/daemon-state.js';
import {
  CLEAR_SCREEN, renderDaemonWatch, shouldRedraw, WATCH_INTERVAL_MS,
} from '../lib/daemon-watch.js';
import {
  createReachCache, loadPodReach, readSessionLastTurn,
} from '../lib/daemon-agent-states.js';
import { installedCliVersion, startUpdateNotice, UPDATE_CHECK_OPT_OUT_ENV } from '../lib/update-check.js';

// One supervised seat, as `commonly daemon status --verbose` names it. Two of these
// fields are worth reading closely: the seat's `instanceId` (the identity the
// platform routes by, so a seat attached to the wrong instance is otherwise
// invisible) and the supervisor's `restarts` flap counter — which is written,
// persisted and served, and was shown by no surface at all, so a seat that had
// been crash-looping looked exactly like a healthy one (TASK-072, 2026-09-19).
//
// `restarts` distinguishes 0 from absent on purpose: a state file written by an
// older daemon has no such field, and printing 0 for it would claim a reading the
// file does not carry.
export const formatSeatLine = (seat = {}) => {
  const model = seat.model || 'default model';
  const effort = seat.effort ? `/${seat.effort}` : '';
  const error = seat.lastError ? ` error=${seat.lastError}` : '';
  const restarts = seat.restarts === undefined || seat.restarts === null ? '-' : seat.restarts;
  return `  ${seat.agentName}: ${seat.state} instance=${seat.instanceId || '-'} adapter=${seat.adapter || 'unknown'} model=${model}${effort} pid=${seat.pid || '-'} restarts=${restarts} lastTurn=${seat.lastTurnAt || 'never'}${error}`;
};

// `daemon status --watch`: one frame, then a redraw every 2 s on a terminal. Off a
// terminal, or with NO_COLOR set, it prints one frame and returns. A failed
// fetch is shown in the frame, so the loop keeps running through a brief outage.
const watchDaemonStatus = async () => {
  const redraw = shouldRedraw({ isTTY: process.stdout.isTTY });
  // Each agent's pod comes from its token record. The verdict for a pod is read
  // through the operator's login and cached for 10 s, so the 2 s frame does not
  // re-read it. A failed read is thrown, so the next frame retries.
  const reachFor = createReachCache({
    load: (podId) => loadPodReach({
      client: createClient({ instance: requireDaemonRecord().instanceUrl }),
      podId,
    }),
  });
  const frame = async () => {
    try {
      const record = requireDaemonRecord();
      // A failed machine read still shows the local seats and logs, with the
      // machine marked unreachable, so the operator can see what is running here.
      let machine;
      let machineNote = '';
      try {
        machine = await getDaemonMachineStatus({
          client: createClient({ instance: record.instanceUrl, token: record.daemonToken }),
          record,
        });
      } catch (error) {
        machine = { name: record.machineName, status: 'unreachable', lastSeenAt: null };
        machineNote = `Machine status unavailable (${error.message}): showing local seats only.`;
      }
      const seats = (loadDaemonState()?.seats || []).map((seat) => ({
        ...seat,
        // The supervisor stamps spawn time; the session store holds real turns.
        lastTurnAt: readSessionLastTurn(seat.agentName),
      }));
      const logTails = {};
      for (const seat of seats) {
        const tail = readLogTail(daemonSeatLogPath(seat.agentName), 3);
        logTails[seat.agentName] = tail ? tail.split('\n') : [];
      }
      let states = null;
      let stateNote = '';
      if (!getToken(record.instanceUrl)) {
        stateNote = `Not logged in: showing local process state only. Run: commonly login --instance ${record.instanceUrl}`;
      } else {
        const podIds = [...new Set(seats.map((seat) => loadAgentToken(seat.agentName)?.podId).filter(Boolean))];
        try {
          states = await reachFor(podIds);
        } catch (error) {
          stateNote = `Agent states unavailable (${error.message}): showing local process state only`;
        }
      }
      return renderDaemonWatch({
        machine, seats, logTails, states, stateNote: [machineNote, stateNote].filter(Boolean).join(' '), now: Date.now(), width: process.stdout.columns || 80, color: redraw,
      });
    } catch (error) {
      return daemonStatusErrorMessage(error);
    }
  };
  if (!redraw) {
    console.log(await frame());
    return;
  }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      process.stdout.write(`${CLEAR_SCREEN}${await frame()}\n`);
    } finally {
      busy = false;
    }
  };
  await tick();
  const timer = setInterval(tick, WATCH_INTERVAL_MS);
  const stop = () => {
    clearInterval(timer);
    process.stdout.write('\n');
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
};

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

export const getDaemonMachineStatus = async ({ client, record }) => {
  const response = await client.get('/api/machines/me');
  const machine = response?.machine;
  if (!machine || typeof machine !== 'object' || Array.isArray(machine)
      || !machine.id || !machine.machineId
      || (record && (machine.id !== record.machineDbId || machine.machineId !== record.machineId))) {
    throw new Error('Unexpected daemon status response; local credential kept.');
  }
  return machine;
};

const isRevokedDaemonKey = (error) => error?.status === 401 && [
  'Daemon token revoked or unknown',
  'Machine access revoked',
].includes(error?.body?.message);

const isMissingDaemonMachine = (error) => error?.status === 404
  && error?.body?.message === 'Machine not found';

const storedDaemonState = async (client, record) => {
  try {
    await getDaemonMachineStatus({ client, record });
    return 'active';
  } catch (error) {
    if (isRevokedDaemonKey(error)) return 'revoked';
    if (isMissingDaemonMachine(error)) return 'missing';
    throw error;
  }
};

export const daemonStatusErrorMessage = (error) => (isRevokedDaemonKey(error)
  ? "This computer's old key was revoked. Run: commonly daemon register"
  : isMissingDaemonMachine(error)
    ? 'This computer is no longer registered. Run: commonly daemon register'
  : `Daemon status failed: ${error.message}`);

// Keep the old record until a new registration is securely persisted. A
// network failure or a still-live daemon key must never silently mint another.
export const allowRevokedDaemonReplacement = async ({ existing, client }) => {
  if (!existing) return null;
  const state = await storedDaemonState(client, existing);
  if (state === 'active') {
    throw new Error(`A local daemon is already registered for ${existing.machineName}. Run: commonly daemon status`);
  }
  return state;
};

// Revoke remotely before unlinking locally. An owner-session 401/403 is not
// proof of revocation: check the stored daemon key before discarding it.
export const unregisterDaemonMachine = async ({
  client, daemonClient, record, remove = removeDaemonRecord,
}) => {
  let removedRemotely = true;
  try {
    await client.del(`/api/machines/${record.machineDbId}`);
  } catch (error) {
    if (isMissingDaemonMachine(error)) {
      removedRemotely = false;
    } else if ([401, 403].includes(error?.status) && daemonClient) {
      if (await storedDaemonState(daemonClient, record) === 'active') throw error;
      removedRemotely = false;
    } else {
      throw error;
    }
  }
  remove();
  return { removedRemotely };
};

// The adapter names a binary on THIS machine — the one fact the server cannot
// know (same reasoning as `agent run`'s env bootstrap). A server-declared
// preference is honored when that CLI is installed; otherwise probe only the
// established fallbacks. OpenCode must be named explicitly in runtime.adapter.
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
  $ commonly daemon status --verbose
  $ commonly daemon logs --seat my-agent -f
  $ commonly daemon start|stop|restart
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
          const state = await allowRevokedDaemonReplacement({
            existing,
            client: createClient({ instance: existing.instanceUrl, token: existing.daemonToken }),
          });
          console.log(state === 'revoked'
            ? "This computer's old key was revoked; registering it again."
            : 'This computer is no longer registered; registering it again.');
        }
        const instanceUrl = resolveInstanceUrl(opts.instance);
        const client = createClient({ instance: instanceUrl, token: requireUserToken(opts.instance || instanceUrl) });
        const { machine, record } = await registerDaemonMachine({
          client,
          instanceUrl,
          name: String(opts.name || hostname()).trim(),
        });
        clearDaemonStop();
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
        if (existing && existsSync(servicePaths(process.platform, homedir()).file)) {
          console.log('Restart the installed daemon to use the new key: commonly daemon restart');
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
        const { removedRemotely } = await unregisterDaemonMachine({
          client,
          daemonClient: createClient({ instance: record.instanceUrl, token: record.daemonToken }),
          record,
        });
        console.log(removedRemotely
          ? `Unregistered ${record.machineName} and removed its local daemon credential.`
          : `Removed ${record.machineName}'s local daemon credential. Server access was already revoked or the machine was removed.`);
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
    // writeFile is deliberately NOT injected here: daemon-service.js's default
    // writer sets the 0600 mode at CREATION, and a bare `writeFileSync(file,
    // content, 'utf8')` dropped that — leaving the service file, which can hold
    // a provider key, readable at umask until the chmod a moment later.
    mkdirp: (dir) => { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); },
    chmod: (path, mode) => chmodSync(path, mode),
    ensureFile: (path) => { const fd = openSync(path, 'a', 0o600); closeSync(fd); },
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

  const runServiceAction = async (action, actionFn) => {
    const deps = serviceDeps();
    const target = servicePaths(process.platform, homedir());
    if (!deps.existsFile(target.file)) {
      throw new Error(`No installed daemon service found. Run: commonly daemon install`);
    }
    await actionFn({ platform: process.platform, home: homedir(), execCmd: deps.execCmd });
    console.log(`Daemon ${action} requested (${target.kind}).`);
  };

  daemon
    .command('install')
    .description('Register the daemon as a login service (launchd/systemd) so it survives reboots')
    .action(async () => {
      try {
        // A service without a credential just crash-loops at boot.
        requireDaemonRecord();
        // Same class one layer over (TASK-049): a service without the SEATS'
        // provider key comes up clean, and every pi seat then dies inside its
        // adapter. The keys are captured here because this is the only moment
        // the operator's shell is in reach; the ones that are missing are named
        // by installDaemonService rather than left to be discovered per seat.
        await installDaemonService({
          ...serviceDeps(),
          providerKeyEnvNames: providerKeyEnvNames(),
          optionalEnvNames: [UPDATE_CHECK_OPT_OUT_ENV],
        });
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

  daemon
    .command('start')
    .description('Start the installed daemon service and return to the terminal')
    .action(async () => {
      try {
        await runServiceAction('start', startDaemonService);
      } catch (error) {
        console.error(`Daemon start failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  daemon
    .command('stop')
    .description('Stop the installed daemon service')
    .action(async () => {
      try {
        await runServiceAction('stop', stopDaemonService);
      } catch (error) {
        console.error(`Daemon stop failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  daemon
    .command('restart')
    .description('Restart the installed daemon service and return to the terminal')
    .action(async () => {
      try {
        await runServiceAction('restart', restartDaemonService);
      } catch (error) {
        console.error(`Daemon restart failed: ${error.message}`);
        process.exitCode = 1;
      }
    });

  // ── run (ADR-026 Phase 2, slice 2) ────────────────────────────────────────
  daemon
    .command('run')
    .description('Run the resident supervisor: adopt requested agents, keep bound agents running, report per-agent state')
    .option('--poll <ms>', 'Work-list poll interval in ms', String(DEFAULT_POLL_MS))
    .option('--heartbeat <ms>', 'Heartbeat interval in ms', String(DEFAULT_HEARTBEAT_MS))
    .option('--foreground', 'Keep the supervisor attached to this terminal (default for direct invocation)')
    .action(async (opts) => {
      let record;
      try {
        const terminal = loadDaemonStop();
        if (terminal) {
          console.error('Daemon stopped: no valid local registration. Run: commonly daemon register');
          process.exitCode = process.platform === 'darwin' ? 0 : terminal.exitCode;
          return;
        }
        record = requireDaemonRecord();
        const stopped = loadDaemonStop(record);
        if (stopped) {
          console.error("Daemon stopped: this computer's key was revoked. Run: commonly daemon register");
          // launchd restarts the first nonzero terminal exit once; a saved
          // verdict makes that second invocation successful and ends the loop.
          process.exitCode = process.platform === 'darwin' ? 0 : stopped.exitCode;
          return;
        }
        const client = createClient({ instance: record.instanceUrl, token: record.daemonToken });
        const logsDir = daemonLogsDir();
        if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
        chmodSync(logsDir, 0o700);
        const stampLog = (line) => console.log(`${new Date().toISOString()} ${line}`);

        // TASK-049: fail loudly at BIND, once, naming the variable.
        //
        // A service-started daemon inherits a clean environment, so a provider
        // key that lives only in the operator's shell is absent here; every pi
        // seat then dies at adapter start with `COMMONLY_LITELLM_KEY is not set`
        // and the operator sees crash loops with no cause at daemon level. One
        // line at startup answers the question the log would otherwise take a
        // seat autopsy to answer. Not fatal: the daemon's other seats are
        // unaffected, and refusing to start would turn one missing key into a
        // whole-machine outage.
        for (const name of missingProviderKeys({ names: providerKeyEnvNames() })) {
          stampLog(`WARNING: ${name} is not set in this environment — a seat whose adapter needs it will fail to start. Export it and re-run: commonly daemon install (docs/agents/daemon-service-environment.md)`);
        }
        // TASK-660: the daemon outlives many publishes, so say once at start-up
        // when it is stale. Not awaited: supervision never waits on the registry.
        startUpdateNotice({ installedVersion: installedCliVersion(), log: stampLog });

        let pollTimer;
        let heartbeatTimer;
        let supervisor;
        let terminalEnded = false;
        const terminalAuth = (error) => isRevokedDaemonKey(error)
          || isMissingDaemonMachine(error);
        const onTerminalAuthError = () => {
          terminalEnded = true;
          let saved = false;
          try {
            saveDaemonStop(record, 77);
            saved = true;
          } catch (error) {
            stampLog(`could not save revoked-machine stop marker: ${error.message}`);
          }
          stampLog("machine key revoked; stopping supervised agents. Run: commonly daemon register");
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          supervisor.stop();
          // Without the marker launchd would restart forever. A successful
          // exit parks it on macOS; systemd honors 77 directly.
          process.exitCode = saved || process.platform !== 'darwin' ? 77 : 0;
        };
        let cachedInventory;
        let inventoryCheckedAt = 0;
        supervisor = createDaemonSupervisor({
          record,
          client,
          isTerminalAuthError: terminalAuth,
          onTerminalAuthError,
          // One child per agent, logging to its own file. The child is the
          // ordinary `commonly agent run <name>` — the daemon is its
          // supervisor, never its replacement (D6).
          spawnChild: (agentName) => {
            const seatLog = daemonSeatLogPath(agentName);
            const out = openSync(seatLog, 'a', 0o600);
            chmodSync(seatLog, 0o600);
            return spawn(process.execPath, [process.argv[1], 'agent', 'run', agentName], {
              stdio: ['ignore', out, out],
              env: { ...process.env, COMMONLY_MANAGED_RUNNER: '1' },
            });
          },
          loadToken: loadAgentToken,
          saveToken: saveAgentToken,
          runtimeInventory: async () => {
            if (!cachedInventory || Date.now() - inventoryCheckedAt > 300_000) {
              cachedInventory = await collectRuntimeInventory(getAdapter);
              inventoryCheckedAt = Date.now();
            }
            return cachedInventory;
          },
          resolveAdapter: (runtime) => resolveAdapterForRuntime(runtime),
          log: stampLog,
          persistState: (seats) => saveDaemonState({
            machineName: record.machineName,
            machineDbId: record.machineDbId,
            updatedAt: new Date().toISOString(),
            seats: seats.map((seat) => ({
              ...seat,
              lastTurnAt: getLastTurn(seat.agentName) || seat.lastTurnAt,
            })),
          }),
        });

        stampLog(`daemon supervising for ${record.machineName} — poll ${opts.poll}ms, heartbeat ${opts.heartbeat}ms (ctrl+c to stop)`);
        await supervisor.tick();
        if (terminalEnded) return;
        await supervisor.heartbeat();
        if (terminalEnded) return;
        const runtimeFailure = (error) => {
          if (terminalEnded) return;
          terminalEnded = true;
          stampLog(`daemon runtime failed: ${error.message}`);
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          supervisor.stop();
          process.exitCode = 75;
        };
        pollTimer = setInterval(() => { void supervisor.tick().catch(runtimeFailure); }, Number(opts.poll) || DEFAULT_POLL_MS);
        heartbeatTimer = setInterval(() => { void supervisor.heartbeat().catch(runtimeFailure); }, Number(opts.heartbeat) || DEFAULT_HEARTBEAT_MS);
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
        const badConfig = !record || error.message.startsWith('Daemon credential file');
        if (badConfig) {
          try {
            saveDaemonStop(record || { machineDbId: 'unregistered' }, 78);
          } catch (markerError) {
            console.error(`Could not save daemon stop marker: ${markerError.message}`);
            if (process.platform === 'darwin') {
              process.exitCode = 0;
              return;
            }
          }
        }
        process.exitCode = badConfig ? 78 : 75;
      }
    });

  daemon
    .command('status')
    .description('Show the server-derived liveness of this machine')
    .option('--verbose', 'Include locally supervised seat state and process details')
    .option('--watch', 'Redraw the machine and agent view every 2 s until Ctrl-C')
    .action(async (opts) => {
      if (opts.watch) {
        await watchDaemonStatus();
        return;
      }
      try {
        const record = requireDaemonRecord();
        const machine = await getDaemonMachineStatus({
          client: createClient({ instance: record.instanceUrl, token: record.daemonToken }),
          record,
        });
        const lastSeen = machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString() : 'never';
        console.log(`${machine.name}: ${machine.status} (last heartbeat: ${lastSeen})`);
        if (opts.verbose) {
          const local = loadDaemonState();
          if (!local) {
            console.log('Local supervisor state: unavailable (daemon has not written state yet).');
          } else if (!local.seats.length) {
            console.log('Local supervisor state: no supervised seats.');
          } else {
            console.log('Local supervised seats:');
            for (const seat of local.seats) console.log(formatSeatLine(seat));
          }
        }
      } catch (error) {
        console.error(daemonStatusErrorMessage(error));
        process.exitCode = 1;
      }
    });

  daemon
    .command('logs')
    .description('Show daemon or per-seat logs')
    .option('--seat <name>', 'Show one supervised seat log instead of the daemon log')
    .option('-f, --follow', 'Continue printing appended log output')
    .option('--lines <n>', 'Number of trailing lines to show', '50')
    .action(async (opts) => {
      const path = opts.seat ? daemonSeatLogPath(opts.seat) : daemonLogPath();
      const printTail = () => {
        const output = readLogTail(path, opts.lines);
        if (output === null) {
          console.error(`No log found at ${path}`);
          return false;
        }
        if (output) console.log(output);
        return true;
      };
      if (!printTail() || !opts.follow) return;
      const watcher = watch(path, () => printTail());
      const close = () => {
        watcher.close();
        process.exit(0);
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    });
};
