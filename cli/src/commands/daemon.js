/**
 * commonly daemon <subcommand>
 *
 * Phase 2, slice 1: register one machine, persist its scoped daemon bearer,
 * and report/send heartbeats. Adoption and supervision deliberately arrive in
 * later slices; this command never reads an agent runtime credential.
 */

import { hostname } from 'os';
import { createClient } from '../lib/api.js';
import { getToken, resolveInstanceUrl } from '../lib/config.js';
import { loadDaemonRecord, saveDaemonRecord } from '../lib/daemon-store.js';

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
        `Could not store the daemon credential and could not revoke machine ${machine.name}: ${revokeError.message}`,
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
  const response = await client.get('/api/machines');
  const machines = Array.isArray(response) ? response : response?.machines || [];
  return machines.find((machine) => machine?.id === record.machineDbId) || null;
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

  daemon
    .command('status')
    .description('Show the server-derived liveness of this machine')
    .action(async () => {
      try {
        const record = requireDaemonRecord();
        const userToken = requireUserToken(record.instanceUrl);
        const machine = await getDaemonMachineStatus({
          client: createClient({ instance: record.instanceUrl, token: userToken }),
          record,
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
