// @ts-nocheck
// The seam nothing else pinned: that recordAgentDmLoopTrip actually OPTS IN to
// repeat suppression. `dedupeWindowMs` is off by default on
// appendSystemExchange, so a helper-only test passes with the wiring deleted —
// the option would simply never be requested and every trip would append.
//
// This is also the only test of any kind for this trigger; grep for
// `recordAgentDmLoopTrip` before this file existed returned two source files
// and zero tests.

const mongoose = require('mongoose');

const AgentMemory = require('../../../models/AgentMemory');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { recordAgentDmLoopTrip } = require('../../../services/systemExchangeTriggers');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('recordAgentDmLoopTrip — repeat suppression wiring', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  const makeDmPod = async () => {
    const bots = await User.create([
      {
        username: 'openclaw-aria',
        email: 'aria@example.test',
        password: 'x',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
      },
      {
        username: 'openclaw-pixel',
        email: 'pixel@example.test',
        password: 'x',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId: 'pixel' },
      },
    ]);
    const pod = await Pod.create({
      name: 'aria ↔ pixel',
      type: 'agent-dm',
      members: bots.map((b) => b._id),
      createdBy: bots[0]._id,
    });
    return String(pod._id);
  };

  const entriesFor = async (instanceId) => {
    const doc = await AgentMemory.findOne({ agentName: 'openclaw', instanceId }).lean();
    return doc?.sections?.system_exchanges?.entries || [];
  };

  it('writes one entry per peer on the first trip', async () => {
    const podId = await makeDmPod();
    await recordAgentDmLoopTrip({ podId, ts: new Date('2026-05-03T00:00:00Z') });

    expect(await entriesFor('aria')).toHaveLength(1);
    expect((await entriesFor('pixel'))[0].kind).toBe('agent-dm-loop-trip');
  });

  it('suppresses a second trip in the same pod inside the window, for BOTH peers', async () => {
    const podId = await makeDmPod();
    await recordAgentDmLoopTrip({ podId, ts: new Date('2026-05-03T00:00:00Z') });
    await recordAgentDmLoopTrip({ podId, ts: new Date('2026-05-03T00:31:00Z') });
    await recordAgentDmLoopTrip({ podId, ts: new Date('2026-05-03T01:15:00Z') });

    // Suppression has to hold on both envelopes: the trigger fans out per peer,
    // so a check that only reads one of them would miss half a regression.
    expect(await entriesFor('aria')).toHaveLength(1);
    expect(await entriesFor('pixel')).toHaveLength(1);
  });

  it('records the recurrence after the 6h window', async () => {
    const podId = await makeDmPod();
    await recordAgentDmLoopTrip({ podId, ts: new Date('2026-05-03T00:00:00Z') });
    await recordAgentDmLoopTrip({ podId, ts: new Date('2026-05-03T06:00:01Z') });

    expect(await entriesFor('aria')).toHaveLength(2);
    expect(await entriesFor('pixel')).toHaveLength(2);
  });

  it('does not suppress across pods', async () => {
    const podA = await makeDmPod();
    await recordAgentDmLoopTrip({ podId: podA, ts: new Date('2026-05-03T00:00:00Z') });
    await clearOnlyPods();
    const podB = await makeDmPod();
    await recordAgentDmLoopTrip({ podId: podB, ts: new Date('2026-05-03T00:10:00Z') });

    expect(await entriesFor('aria')).toHaveLength(2);
  });

  // Pods are recreated rather than cleared wholesale so the memory envelopes
  // written by the first trip survive into the second — clearing everything
  // would make the cross-pod case pass for the wrong reason.
  async function clearOnlyPods() {
    await Pod.deleteMany({});
    await User.deleteMany({});
  }

  it('ignores a non-agent-dm pod entirely', async () => {
    const bot = await User.create({
      username: 'openclaw-solo',
      email: 'solo@example.test',
      password: 'x',
      isBot: true,
      botMetadata: { agentName: 'openclaw', instanceId: 'solo' },
    });
    const pod = await Pod.create({
      name: 'a channel',
      type: 'chat',
      members: [bot._id],
      createdBy: bot._id,
    });
    await recordAgentDmLoopTrip({ podId: String(pod._id) });
    expect(await entriesFor('solo')).toHaveLength(0);
  });

  it('never throws on a bad podId — the trigger is fire-and-forget', async () => {
    await expect(recordAgentDmLoopTrip({ podId: 'not-an-object-id' })).resolves.toBeUndefined();
    await expect(
      recordAgentDmLoopTrip({ podId: String(new mongoose.Types.ObjectId()) }),
    ).resolves.toBeUndefined();
  });
});
