/**
 * Local daemon credential storage.
 *
 * A daemon is one machine-level supervisor, not an agent token file. Keep its
 * credential in its own 0700 directory and enforce 0600 on every write; the
 * bearer must never be printed or placed in the ordinary CLI config file.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const daemonDir = () => join(homedir(), '.commonly', 'daemon');
export const daemonRecordPath = () => join(daemonDir(), 'machine.json');

const validateRecord = (record) => {
  if (!record
    || typeof record.machineDbId !== 'string'
    || typeof record.machineId !== 'string'
    || typeof record.machineName !== 'string'
    || typeof record.instanceUrl !== 'string'
    || typeof record.daemonToken !== 'string'
    || !record.daemonToken.startsWith('cm_daemon_')) {
    throw new Error('Daemon credential file is invalid. Revoke the machine before registering again.');
  }
  return record;
};

export const loadDaemonRecord = () => {
  const path = daemonRecordPath();
  if (!existsSync(path)) return null;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error('Daemon credential file permissions are insecure. Set them to 0600 before running the daemon.');
  }
  try {
    return validateRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Daemon credential file')) throw error;
    throw new Error('Daemon credential file is unreadable. Revoke the machine before registering again.');
  }
};

export const saveDaemonRecord = (record) => {
  const safeRecord = validateRecord(record);
  const dir = daemonDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const path = daemonRecordPath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(safeRecord, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};
