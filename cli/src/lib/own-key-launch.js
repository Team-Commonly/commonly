import { loadDaemonRecord } from './daemon-store.js';
import { createClient } from './api.js';

// The daemon bearer stays in this parent closure. Seat tokens can be inherited
// by model children during mint fallback, so they never authorize key reads.
export const createOwnKeyResolver = ({ instanceUrl, machineId, agentName, instanceId = 'default',
  loadRecord = loadDaemonRecord, clientFactory = createClient }) => async ({ opened, harness, provider }) => {
  if (harness !== 'opencode' || !provider) return undefined;
  const record = loadRecord();
  if (!record || (machineId && record.machineId !== machineId)
    || new URL(record.instanceUrl).href !== new URL(instanceUrl).href) {
    throw new Error('Own provider key requires this machine’s registered daemon');
  }
  let launch;
  try {
    launch = await clientFactory({ instance: instanceUrl, token: record.daemonToken })
      .post('/api/agents/runtime/provider-key/launch', { agentName, instanceId, harness,
        providerId: provider.id, baseURL: provider.baseURL, metadataOnly: opened?.source !== 'spawn' });
  } catch (error) {
    if ([404, 405].includes(error.status)) return undefined;
    throw new Error('Own provider key could not be resolved; retry after checking Settings');
  }
  if (!launch?.set) return undefined;
  if (opened?.source !== 'spawn') {
    const error = new Error('Own provider key requires a scoped spawn credential; turn was not started');
    error.ownKeySpawnRefused = true;
    throw error;
  }
  return launch.key;
};

// Parent-only receipt client. Failure to load machine authority disables
// diagnostics; it must never fall back to a seat bearer.
export const createMachineReportClient = ({ instanceUrl, machineId, agentName, instanceId = 'default' }) => {
  try {
    const record = loadDaemonRecord();
    if (!record || (machineId && machineId !== record.machineId)
      || new URL(record.instanceUrl).href !== new URL(instanceUrl).href) return null;
    const client = createClient({ instance: instanceUrl, token: record.daemonToken });
    return { post: (path, body) => client.post(path, { ...body, agentName, instanceId }) };
  } catch { return null; }
};
