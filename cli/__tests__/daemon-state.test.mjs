import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  daemonStateDir,
  daemonStatePath,
  loadDaemonState,
  saveDaemonState,
} from '../src/lib/daemon-state.js';

const mode = (path) => statSync(path).mode & 0o777;

test('daemon state is private and allow-listed, never a credential dump', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-daemon-state-'));
  saveDaemonState({
    machineName: 'Mac',
    machineDbId: 'machine-1',
    daemonToken: 'cm_daemon_secret',
    seats: [{
      agentName: 'wren', state: 'running', pid: 42, adapter: 'claude',
      model: 'fable', effort: 'high', runtimeToken: 'cm_agent_secret',
      environment: { mcp: [{ env: { SECRET: 'do-not-write' } }] },
      lastError: 'request bearer=cm_agent_secret failed',
    }],
  }, { home });

  expect(mode(daemonStateDir(home))).toBe(0o700);
  expect(mode(daemonStatePath(home))).toBe(0o600);
  const raw = readFileSync(daemonStatePath(home), 'utf8');
  expect(raw).not.toMatch(/cm_(?:daemon|agent)_/);
  expect(raw).not.toMatch(/SECRET|environment|runtimeToken|token/i);
  expect(loadDaemonState({ home })).toEqual(expect.objectContaining({
    machineName: 'Mac',
    seats: [expect.objectContaining({ agentName: 'wren', pid: 42 })],
  }));
  expect(loadDaemonState({ home }).seats[0].lastError).toBe('child process error');
});
