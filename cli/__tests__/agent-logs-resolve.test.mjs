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
const ember = { name: 'ember', instanceId: 'default', mention: 'ember' };

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
    // Each pair is what to pass back: the agentName and its instance.
    await expect(resolveLogsSeat(roster([pixel, nova]), 'pod-1', 'openclaw'))
      .rejects.toThrow(/2 seats are named 'openclaw' here: openclaw\/pixel, openclaw\/nova\. Run: commonly agent logs <agentName> --pod pod-1 --instance-id <instance>/);
  });

  test('a name the roster lacks falls back to the default instance, and says so', async () => {
    const seat = await resolveLogsSeat(roster([walk, pixel]), 'pod-1', 'embr');
    expect(seat).toMatchObject({ agentName: 'embr', instanceId: 'default' });
    // Otherwise a typo reads exactly like an idle seat.
    expect(seat.note).toBe("'embr' is not in this pod's roster, so instance default was read. Seats here: @cto-walk-1016-cto-walk, @openclaw-pixel");
  });

  test('typing "default" does not match every seat on the default instance', async () => {
    const seat = await resolveLogsSeat(roster([ember, { ...ember, name: 'rivet', mention: 'rivet' }]), 'pod-1', 'default');
    expect(seat).toMatchObject({ agentName: 'default', instanceId: 'default' });
  });
});
