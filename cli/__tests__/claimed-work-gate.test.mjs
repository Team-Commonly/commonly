/**
 * Defer-while-claimed (TASK-640). A seat holding a claimed row spawns no turn
 * for a broadcast no person sent, and still spawns for everything addressed to
 * it, for human posts, and for news about its own row.
 */
import { describe, expect, jest, test } from '@jest/globals';

import { createClaimedWorkGate, isDeferrableWhileClaimed } from '../src/lib/claimed-work-gate.js';

const POD = 'pod-1';
const broadcast = (payload = {}) => ({ type: 'message.posted', deliveryMode: 'wake', payload: { messageId: 'm1', ...payload } });
const board = (rows) => ({ get: jest.fn().mockResolvedValue({ tasks: rows }) });
const HOLDS_642 = [
  { taskId: 'TASK-642', claimedByMe: true, leaseState: 'held' },
  { taskId: 'TASK-700', claimedByMe: false, leaseState: 'held' },
];

describe('isDeferrableWhileClaimed', () => {
  const held = new Set(['TASK-642']);

  test.each([
    ['an agent broadcast', broadcast(), 'agent', true],
    ['a kernel board broadcast about another row', broadcast({ taskId: 'TASK-700' }), 'kernel', true],
    ['a human post', broadcast(), 'human', false],
    ['an unclassifiable trigger', broadcast(), 'unknown', false],
    ['a broadcast about the seat\'s own row', broadcast({ taskId: 'TASK-642' }), 'kernel', false],
    ['an addressed broadcast', broadcast({ addressed: true }), 'agent', false],
    ['a reply to the seat\'s own message', broadcast({ repliesToYourMessage: true }), 'agent', false],
    ['a lease warning for another row', broadcast({ leaseWarningTaskId: 'TASK-700' }), 'kernel', false],
    ['a dependency-done board wake', broadcast({ boardWake: true, wakeReason: 'dependency-done', taskId: 'TASK-700' }), 'agent', false],
    ['a board wake folded into another row', broadcast({ boardWake: true, wakeReason: 'edited', taskId: 'TASK-700' }), 'agent', false],
    ['a board wake assigning a new row', broadcast({ boardWake: true, wakeReason: 'assigned', taskId: 'TASK-701' }), 'agent', false],
    ['the reasonless found-work nudge', broadcast({ boardWake: true, foundWorkAt: 1 }), 'kernel', true],
    ['a chat mention', { type: 'chat.mention', payload: {} }, 'agent', false],
    ['a DM', { type: 'dm.message', payload: {} }, 'agent', false],
    ['a heartbeat', { type: 'heartbeat', payload: {} }, 'kernel', false],
    ['a digest entry', { ...broadcast(), deliveryMode: 'digest' }, 'agent', false],
  ])('%s → %s', (_label, event, trigger, expected) => {
    expect(isDeferrableWhileClaimed(event, trigger, held)).toBe(expected);
  });
});

describe('createClaimedWorkGate', () => {
  test('defers an agent broadcast while the seat holds a row in the pod', async () => {
    const client = board(HOLDS_642);
    const gate = createClaimedWorkGate({ client });
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(true);
    expect(client.get).toHaveBeenCalledWith(`/api/v1/tasks/${POD}`, { status: 'claimed' });
  });

  test('does not defer when the seat holds nothing, even if peers do', async () => {
    const gate = createClaimedWorkGate({ client: board([{ taskId: 'TASK-700', claimedByMe: false, leaseState: 'held' }]) });
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(false);
  });

  test('does not defer on a lapsed lease the seat still names', async () => {
    const lapsed = [{ taskId: 'TASK-642', claimedByMe: true, leaseState: 'lapsed' }];
    const gate = createClaimedWorkGate({ client: board(lapsed) });
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(false);
  });

  test('fails open on a kernel that does not mark claimedByMe', async () => {
    const gate = createClaimedWorkGate({ client: board([{ taskId: 'TASK-642', claimedBy: 'someone', leaseState: 'held' }]) });
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(false);
  });

  test('fails open when the board read errors', async () => {
    const gate = createClaimedWorkGate({ client: { get: jest.fn().mockRejectedValue(new Error('503')) } });
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(false);
  });

  test('a batch with one human post or mention is not deferred', async () => {
    const gate = createClaimedWorkGate({ client: board(HOLDS_642) });
    await expect(gate.shouldDefer(POD, [
      { event: broadcast(), trigger: 'agent' },
      { event: broadcast({ messageId: 'm2' }), trigger: 'human' },
    ])).resolves.toBe(false);
    await expect(gate.shouldDefer(POD, [
      { event: broadcast(), trigger: 'agent' },
      { event: { type: 'chat.mention', payload: {} }, trigger: 'agent' },
    ])).resolves.toBe(false);
  });

  test('a batch defers only when every entry may wait', async () => {
    const gate = createClaimedWorkGate({ client: board(HOLDS_642) });
    await expect(gate.shouldDefer(POD, [
      { event: broadcast(), trigger: 'agent' },
      { event: broadcast({ messageId: 'm2', taskId: 'TASK-700' }), trigger: 'kernel' },
    ])).resolves.toBe(true);
    await expect(gate.shouldDefer(POD, [
      { event: broadcast(), trigger: 'agent' },
      { event: broadcast({ messageId: 'm2', taskId: 'TASK-642' }), trigger: 'kernel' },
    ])).resolves.toBe(false);
  });

  test('a turn that spawns drops the cached claim, so a released row stops deferring', async () => {
    const client = { get: jest.fn()
      .mockResolvedValueOnce({ tasks: HOLDS_642 })
      .mockResolvedValueOnce({ tasks: [] }) };
    const gate = createClaimedWorkGate({ client, ttlMs: 60_000, now: () => 0 });
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(true);
    // A human post spawns a turn; the seat may complete its row in it.
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'human' }])).resolves.toBe(false);
    await expect(gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }])).resolves.toBe(false);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  test('reads the board only when the group could be deferred, and caches the read', async () => {
    let at = 0;
    const client = board(HOLDS_642);
    const gate = createClaimedWorkGate({ client, ttlMs: 1000, now: () => at });
    await gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'human' }]);
    expect(client.get).not.toHaveBeenCalled();

    await gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }]);
    await gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }]);
    expect(client.get).toHaveBeenCalledTimes(1);

    at = 1500;
    await gate.shouldDefer(POD, [{ event: broadcast(), trigger: 'agent' }]);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  test('an empty group is never deferred', async () => {
    const gate = createClaimedWorkGate({ client: board(HOLDS_642) });
    await expect(gate.shouldDefer(POD, [])).resolves.toBe(false);
  });
});
