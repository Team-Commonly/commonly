/**
 * F44 (C): `agent logs <name> --pod` sent instance "default" unless told
 * otherwise, so a seat with any other instance printed "No recent activity".
 * The seat is now looked up in the pod roster by any of its names.
 */

import { jest } from '@jest/globals';

const { resolveLogsSeat } = await import('../src/commands/agent.js');

const roster = (agents) => ({ get: jest.fn(async () => ({ agents })) });
const walk = { name: 'cto-walk-1016', instanceId: 'cto-walk', mention: 'cto-walk-1016-cto-walk' };
const pixel = { name: 'openclaw', instanceId: 'pixel', mention: 'openclaw-pixel' };
const nova = { name: 'openclaw', instanceId: 'nova', mention: 'openclaw-nova' };

describe('resolveLogsSeat', () => {
  test.each([
    ['its agentName', 'cto-walk-1016'],
    ['its instance', 'cto-walk'],
    ['its handle', 'cto-walk-1016-cto-walk'],
    ['its handle with an @', '@cto-walk-1016-cto-walk'],
  ])('finds a non-default seat by %s', async (_label, typed) => {
    const client = roster([walk, pixel, nova]);
    await expect(resolveLogsSeat(client, 'pod-1', typed)).resolves.toEqual({ agentName: 'cto-walk-1016', instanceId: 'cto-walk' });
    expect(client.get).toHaveBeenCalledWith('/api/registry/pods/pod-1/agents');
  });

  test('an explicit --instance-id is used as given, with no roster read', async () => {
    const client = roster([walk]);
    await expect(resolveLogsSeat(client, 'pod-1', 'cto-walk-1016', 'other')).resolves.toEqual({ agentName: 'cto-walk-1016', instanceId: 'other' });
    expect(client.get).not.toHaveBeenCalled();
  });

  test('an agentName two seats share names the instances to choose from', async () => {
    await expect(resolveLogsSeat(roster([pixel, nova]), 'pod-1', 'openclaw'))
      .rejects.toThrow(/2 seats are named 'openclaw' here: pixel, nova\. Pass --instance-id/);
  });

  test('a name the roster lacks falls back to the default instance', async () => {
    await expect(resolveLogsSeat(roster([walk]), 'pod-1', 'ember')).resolves.toEqual({ agentName: 'ember', instanceId: 'default' });
  });
});
