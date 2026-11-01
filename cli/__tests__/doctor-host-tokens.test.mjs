/**
 * The production wiring of doctor's agent listing (TASK-660): hostDoctorDeps
 * must hand runDoctor the unreadable token files, or a malformed file reads as
 * "no agent here" again. HOME is a temp dir, so nothing on this host is read.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-doctor-host-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => tmp },
  homedir: () => tmp,
}));

const { hostDoctorDeps } = await import('../src/commands/doctor.js');
const { saveAgentToken } = await import('../src/commands/agent.js');

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hostDoctorDeps lists the agents that load and names the token file that does not', () => {
  saveAgentToken('fine', {
    agentName: 'fine', instanceId: 'default', podId: 'pod-f',
    instanceUrl: 'http://localhost:5000', runtimeToken: 'cm_agent_f', adapter: 'claude',
  });
  fs.writeFileSync(path.join(tmp, '.commonly', 'tokens', 'broken.json'), '{"agentName": ', 'utf8');

  const deps = hostDoctorDeps();
  expect(deps.listAgents().map((a) => a.name)).toEqual(['fine']);
  expect(deps.listUnreadable()).toEqual(['broken']);
});
