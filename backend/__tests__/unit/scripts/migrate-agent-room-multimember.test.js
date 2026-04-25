// Unit-test the planner branches in migrate-agent-room-multimember.ts.
// We mock Pod + User so the test runs without a real Mongo connection.

jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn() }));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { migrateAgentRoomMultimember } = require('../../../scripts/migrate-agent-room-multimember');

// Build a fake Pod doc that responds to .save() and exposes mutable fields.
const fakePod = ({ _id, type = 'agent-room', name = 'pod', createdBy, members }) => {
  const doc = {
    _id, type, name, createdBy, members,
    save: jest.fn().mockResolvedValue(undefined),
  };
  return doc;
};

// Mock Mongoose's `.cursor()` chain — return a thenable async iterator.
const cursorOf = (docs) => ({
  async *[Symbol.asyncIterator]() { for (const d of docs) yield d; },
});

const userLeanFor = (records) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(records),
  }),
});

describe('migrateAgentRoomMultimember', () => {
  beforeEach(() => jest.clearAllMocks());

  test('1 host agent + 1 human + N rogue agents → restore [host, human], stay agent-room', async () => {
    const pod = fakePod({
      _id: 'p1',
      createdBy: 'host-agent-id',
      members: ['host-agent-id', 'human-id', 'rogue-1', 'rogue-2', 'rogue-3'],
    });
    Pod.find.mockReturnValue({ cursor: () => cursorOf([pod]) });
    User.find.mockReturnValue(userLeanFor([
      { _id: 'host-agent-id', isBot: true },
      { _id: 'human-id', isBot: false },
      { _id: 'rogue-1', isBot: true },
      { _id: 'rogue-2', isBot: true },
      { _id: 'rogue-3', isBot: true },
    ]));

    const r = await migrateAgentRoomMultimember();
    expect(r.total).toBe(1);
    expect(r.applied).toBe(1);
    expect(r.plans[0]).toEqual(expect.objectContaining({
      action: 'restore-1to1-human-agent',
      before: 5,
      after: 2,
      keepIds: expect.arrayContaining(['host-agent-id', 'human-id']),
      dropIds: expect.arrayContaining(['rogue-1', 'rogue-2', 'rogue-3']),
    }));
    expect(pod.members).toEqual(['host-agent-id', 'human-id']);
    expect(pod.type).toBe('agent-room');
    expect(pod.save).toHaveBeenCalled();
  });

  test('0 humans → agent↔agent DM, keep [members[0], members[1]] by insertion order', async () => {
    const pod = fakePod({
      _id: 'p2',
      createdBy: 'agent-host',
      members: ['agent-host', 'agent-other', 'rogue-a', 'rogue-b'],
    });
    Pod.find.mockReturnValue({ cursor: () => cursorOf([pod]) });
    User.find.mockReturnValue(userLeanFor([
      { _id: 'agent-host', isBot: true },
      { _id: 'agent-other', isBot: true },
      { _id: 'rogue-a', isBot: true },
      { _id: 'rogue-b', isBot: true },
    ]));

    const r = await migrateAgentRoomMultimember();
    expect(r.plans[0].action).toBe('restore-1to1-agent-agent');
    // Order matters here: the first kept ID must be the host (memberIds[0])
    // and the second the original counter-party (memberIds[1]). The script's
    // implementation hands these to a Set then expands — Set iteration is
    // insertion-ordered in V8 — so the surface order is stable.
    expect(r.plans[0].keepIds).toEqual(['agent-host', 'agent-other']);
    expect(r.plans[0].dropIds).toEqual(expect.arrayContaining(['rogue-a', 'rogue-b']));
    expect(pod.members).toEqual(['agent-host', 'agent-other']);
    expect(pod.type).toBe('agent-room');
  });

  test('2+ humans → was never a DM, convert to chat, members preserved', async () => {
    const pod = fakePod({
      _id: 'p3',
      createdBy: 'agent-host',
      members: ['agent-host', 'human-a', 'human-b', 'human-c'],
    });
    Pod.find.mockReturnValue({ cursor: () => cursorOf([pod]) });
    User.find.mockReturnValue(userLeanFor([
      { _id: 'agent-host', isBot: true },
      { _id: 'human-a', isBot: false },
      { _id: 'human-b', isBot: false },
      { _id: 'human-c', isBot: false },
    ]));

    const r = await migrateAgentRoomMultimember();
    expect(r.plans[0].action).toBe('convert-to-chat');
    expect(pod.type).toBe('chat');
    expect(pod.members).toEqual(['agent-host', 'human-a', 'human-b', 'human-c']);
  });

  test('--dry mode reports a plan but does not save', async () => {
    const pod = fakePod({
      _id: 'p4',
      createdBy: 'host-agent-id',
      members: ['host-agent-id', 'human-id', 'rogue-1'],
    });
    Pod.find.mockReturnValue({ cursor: () => cursorOf([pod]) });
    User.find.mockReturnValue(userLeanFor([
      { _id: 'host-agent-id', isBot: true },
      { _id: 'human-id', isBot: false },
      { _id: 'rogue-1', isBot: true },
    ]));

    const r = await migrateAgentRoomMultimember({ dryRun: true });
    expect(r.skipped).toBe(1);
    expect(r.applied).toBe(0);
    expect(pod.save).not.toHaveBeenCalled();
    expect(pod.members).toEqual(['host-agent-id', 'human-id', 'rogue-1']); // unchanged
  });

  test('idempotent — pods with members.length <= 2 are not even returned by the cursor query', async () => {
    // The Mongo $expr filter excludes 2-member pods; the cursor sees only
    // offenders. A clean DB after a prior run yields zero docs and zero work.
    Pod.find.mockReturnValue({ cursor: () => cursorOf([]) });
    const r = await migrateAgentRoomMultimember();
    expect(r.total).toBe(0);
    expect(r.applied).toBe(0);
  });

  test('createdBy not in members → skip with a warning, do not write a ghost ID', async () => {
    // Edge case: a pod where `pod.createdBy` (the supposed host agent) is
    // NOT in `pod.members`. Could only happen via data corruption or a
    // bulk-import that bypassed the create hook. The human-branch code
    // computes `keepIds = [hostId, the_human]` from createdBy + the_human;
    // without a guard it would silently produce a 2-member pod where
    // hostId is a ghost — no AgentInstallation, no User session would match.
    const pod = fakePod({
      _id: 'p-ghost',
      createdBy: 'ghost-host-id', // not in members
      members: ['someone-else-agent', 'human-id', 'rogue-1'],
    });
    Pod.find.mockReturnValue({ cursor: () => cursorOf([pod]) });
    User.find.mockReturnValue(userLeanFor([
      { _id: 'someone-else-agent', isBot: true },
      { _id: 'human-id', isBot: false },
      { _id: 'rogue-1', isBot: true },
    ]));

    const r = await migrateAgentRoomMultimember();
    expect(r.total).toBe(1);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    // Pod must remain untouched — operator triages manually.
    expect(pod.members).toEqual(['someone-else-agent', 'human-id', 'rogue-1']);
    expect(pod.type).toBe('agent-room');
    expect(pod.save).not.toHaveBeenCalled();
  });
});
