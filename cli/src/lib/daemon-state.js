import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The state file is deliberately next to the daemon credential, but it never
// contains one. Keeping both under the already-private daemon directory makes
// it difficult for a future status field to accidentally become world-readable.
export const daemonStateDir = (home = homedir()) => join(home, '.commonly', 'daemon');
export const daemonStatePath = (home = homedir()) => join(daemonStateDir(home), 'state.json');

const fixedLastError = (value) => {
  if (!value) return null;
  const match = typeof value === 'string'
    ? value.match(/^child exited with code (-?\d+|null)$/)
    : null;
  return match ? `child exited with code ${match[1]}` : 'child process error';
};

const seatState = (seat = {}) => ({
  agentName: seat.agentName,
  instanceId: seat.instanceId,
  state: seat.state,
  restarts: seat.restarts,
  adapter: seat.adapter || null,
  model: seat.model || null,
  effort: seat.effort || null,
  pid: Number.isInteger(seat.pid) ? seat.pid : null,
  lastTurnAt: seat.lastTurnAt || null,
  lastError: fixedLastError(seat.lastError),
});

// Pick fields rather than serializing arbitrary supervisor objects. This is a
// security boundary: no token, environment, or child-process metadata can be
// persisted merely because a future caller adds it to a runtime row.
export const publicDaemonState = (state = {}) => ({
  machineName: state.machineName || null,
  machineDbId: state.machineDbId || null,
  updatedAt: state.updatedAt || new Date().toISOString(),
  seats: Array.isArray(state.seats) ? state.seats.map(seatState) : [],
});

export const saveDaemonState = (state, { home = homedir() } = {}) => {
  const dir = daemonStateDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = daemonStatePath(home);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(publicDaemonState(state), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return path;
};

export const loadDaemonState = ({ home = homedir() } = {}) => {
  try {
    const parsed = JSON.parse(readFileSync(daemonStatePath(home), 'utf8'));
    return publicDaemonState(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Could not read daemon state: ${error.message}`);
  }
};

export const removeDaemonState = ({ home = homedir() } = {}) => {
  try {
    unlinkSync(daemonStatePath(home));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};
