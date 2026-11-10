/**
 * run-instance.test.mjs — F306
 *
 * A second instance of an agent (same name, another instanceId) has its own
 * key. `commonly agent run <name> --instance-id <id>` runs that instance, and
 * its token file is `<name>@<id>.json`, so it never overwrites the default
 * instance's `<name>.json`. A key for one instance never runs as another.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tokensTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-instance-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => tokensTmpDir },
    homedir: () => tokensTmpDir,
  };
});

const {
  seatKey, parseRunInstanceId, runInstanceRefusal, saveAgentToken, loadAgentToken, performDetach,
} = await import('../src/commands/agent.js');

afterAll(() => {
  fs.rmSync(tokensTmpDir, { recursive: true, force: true });
});

describe('seatKey', () => {
  test('the default instance keeps the bare name', () => {
    expect(seatKey('nova')).toBe('nova');
    expect(seatKey('nova', 'default')).toBe('nova');
    expect(seatKey('nova', 'Default')).toBe('nova');
  });

  test('another instance is keyed name@instance', () => {
    expect(seatKey('nova', 'priya-nova')).toBe('nova@priya-nova');
  });
});

describe('parseRunInstanceId', () => {
  test('takes a plain instance id, and none when nothing names one', () => {
    // Unnamed: the run keeps its old behaviour, keyed by the bare name.
    expect(parseRunInstanceId(undefined, 'nova')).toBeNull();
    expect(parseRunInstanceId('default', 'nova')).toBe('default');
    expect(parseRunInstanceId('priya-nova', 'nova')).toBe('priya-nova');
    expect(parseRunInstanceId('team.v2_a', 'nova')).toBe('team.v2_a');
  });

  test('refuses an id that could leave the tokens folder or is not an id', () => {
    for (const bad of ['../x', 'a/b', 'a b', '', '@x', 'x'.repeat(65)]) {
      expect(() => parseRunInstanceId(bad, 'nova')).toThrow(/--instance-id/);
    }
  });

  test('refuses a flag on a name that already names an instance', () => {
    expect(() => parseRunInstanceId('other', 'nova@priya-nova')).toThrow(/already names instance/);
    // Naming the seat key alone selects that instance: that is how the daemon starts it.
    expect(parseRunInstanceId(undefined, 'nova@priya-nova')).toBe('priya-nova');
    expect(parseRunInstanceId('priya-nova', 'nova@priya-nova')).toBe('priya-nova');
  });
});

describe('runInstanceRefusal', () => {
  test('passes a record for the instance asked for', () => {
    expect(runInstanceRefusal({ record: { agentName: 'nova', instanceId: 'priya-nova' }, instanceId: 'priya-nova' })).toBeNull();
    expect(runInstanceRefusal({ record: { agentName: 'nova' }, instanceId: 'default' })).toBeNull();
    expect(runInstanceRefusal({ record: { agentName: 'nova', instanceId: 'PRIYA-NOVA' }, instanceId: 'priya-nova' })).toBeNull();
  });

  test('refuses a key for another instance and names the command that runs it', () => {
    const second = runInstanceRefusal({ record: { agentName: 'nova', instanceId: 'priya-nova' }, instanceId: 'default' });
    expect(second).toMatch(/instance priya-nova/);
    expect(second).toContain('commonly agent run nova --instance-id priya-nova');
    const first = runInstanceRefusal({ record: { agentName: 'nova', instanceId: 'default' }, instanceId: 'priya-nova' });
    expect(first).toMatch(/instance default/);
    expect(first).toContain('commonly agent run nova');
    expect(first).not.toContain('--instance-id');
  });
});

describe('token files per instance', () => {
  test("a second instance's key never overwrites the default instance's", () => {
    saveAgentToken(seatKey('nova', 'default'), { agentName: 'nova', instanceId: 'default', runtimeToken: 'cm_agent_first' });
    saveAgentToken(seatKey('nova', 'priya-nova'), { agentName: 'nova', instanceId: 'priya-nova', runtimeToken: 'cm_agent_second' });
    expect(loadAgentToken('nova').runtimeToken).toBe('cm_agent_first');
    expect(loadAgentToken('nova@priya-nova').runtimeToken).toBe('cm_agent_second');
    expect(fs.existsSync(path.join(tokensTmpDir, '.commonly', 'tokens', 'nova@priya-nova.json'))).toBe(true);
  });

  test("detaching a second instance removes its own key and leaves the default's", async () => {
    saveAgentToken('nova', { agentName: 'nova', instanceId: 'default', runtimeToken: 'cm_agent_first' });
    saveAgentToken('nova@priya-nova', { agentName: 'nova', instanceId: 'priya-nova', runtimeToken: 'cm_agent_second' });
    await performDetach({
      agentName: 'nova', instanceId: 'priya-nova', localKey: 'nova@priya-nova', skipBackend: true,
    });
    expect(loadAgentToken('nova@priya-nova')).toBeNull();
    expect(loadAgentToken('nova').runtimeToken).toBe('cm_agent_first');
  });
});
