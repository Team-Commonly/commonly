/**
 * Claim-decline recovery crosses two persistence layers: PostgreSQL owns the
 * message lease; Mongo owns the original wake cohort. This Tier 1 test uses
 * both real services. pg-mem cannot parse the PostgreSQL array/CAS expression
 * that appends a decliner, so a unit mock would be actively misleading here.
 */

/* eslint-disable import/extensions, import/no-unresolved -- backend TypeScript
 * modules expose CJS compatibility exports. */

const mongoose = require('mongoose');

const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { pool } = require('../../config/db-pg');
const MessageClaimService = require('../../services/messageClaimService');
const MessageClaimHandoffService = require('../../services/messageClaimHandoffService');

const describeTier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;

describeTier1('message claim decline handoff — real Mongo + PostgreSQL', () => {
  const podId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const messageId = 'human-message-claim-handoff';

  const sourcePayload = (agentName) => ({
    messageId,
    content: `Human message, addressed to ${agentName}.`,
    wakeOnMessage: true,
    senderIsHuman: true,
  });

  const seedCohort = async (names) => {
    await Promise.all(names.map((agentName) => AgentInstallation.create({
      agentName,
      instanceId: 'default',
      podId,
      version: '1.0.0',
      installedBy: ownerId,
      config: { wakeOnMessage: { enabled: true } },
    })));
    await AgentEvent.insertMany(names.map((agentName) => ({
      agentName,
      instanceId: 'default',
      podId,
      type: 'message.posted',
      payload: sourcePayload(agentName),
    })));
  };

  beforeAll(async () => {
    // This suite is Tier 1 by construction. Keep its bootstrap local rather
    // than importing testUtils: that helper also initialises pg-mem for Tier
    // 0 and cannot exercise PostgreSQL's array/CAS expression.
    await mongoose.connect(process.env.MONGO_URI);
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    // The self-bootstrapping claim table is intentionally not in schema.sql.
    // It exists after the first test; tolerate first-run before its creation.
    await pool.query('DELETE FROM message_claims').catch((err) => {
      if (!/message_claims/i.test(err.message)) throw err;
    });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM message_claims').catch(() => undefined);
    await mongoose.disconnect();
    // config/db-pg owns its own pg.Pool (separate from the test helper's
    // pg-mem pool), so close it explicitly or this Tier 1 suite leaks a
    // socket and Jest correctly reports an open handle.
    await pool.end();
  });

  test('a decline reaches one other active installation, which can claim it', async () => {
    await seedCohort(['seat-a', 'seat-b']);
    expect(await MessageClaimService.claim({
      messageId, podId: String(podId), agentName: 'seat-a',
    })).toMatchObject({ claimed: true });

    const release = await MessageClaimHandoffService.release({
      messageId, agentName: 'seat-a', outcome: 'declined',
    });

    expect(release).toMatchObject({ handoff: { queued: true, agentName: 'seat-b' } });
    const reoffers = await AgentEvent.find({ 'payload.claimHandoff': { $exists: true } }).lean();
    expect(reoffers).toHaveLength(1);
    expect(reoffers[0]).toMatchObject({
      agentName: 'seat-b',
      payload: expect.objectContaining({ claimHandoff: { attempt: 1 }, senderIsHuman: true }),
    });

    expect(await MessageClaimService.claim({
      messageId, podId: String(podId), agentName: 'seat-b',
    })).toMatchObject({ claimed: true, declinedBy: ['seat-a:default'] });
  });

  test('five declines consume the original five-seat cohort and stop', async () => {
    const names = ['seat-a', 'seat-b', 'seat-c', 'seat-d', 'seat-e'];
    await seedCohort(names);

    await names.reduce(async (previous, agentName, index) => {
      await previous;
      expect(await MessageClaimService.claim({
        messageId, podId: String(podId), agentName,
      })).toMatchObject({ claimed: true });
      // Every decline is sequential because only the one re-offered seat is
      // allowed to attempt the next claim — this is the no-stampede contract.
      const release = await MessageClaimHandoffService.release({
        messageId, agentName, outcome: 'declined',
      });
      if (index < names.length - 1) {
        expect(release).toMatchObject({ handoff: { queued: true, agentName: names[index + 1] } });
      } else {
        expect(release).toMatchObject({ handoff: { queued: false, reason: 'no_remaining_wake_target' } });
      }
    }, Promise.resolve());

    const reoffers = await AgentEvent.find({ 'payload.claimHandoff': { $exists: true } })
      .sort({ createdAt: 1 }).lean();
    expect(reoffers.map((event) => event.agentName)).toEqual(names.slice(1));
    expect(reoffers).toHaveLength(4);
  });
});
