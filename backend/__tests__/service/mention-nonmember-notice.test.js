const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { findNonMemberMentionNotices } = require('../../services/mentionNonMemberNoticeService');

describe('non-member mention destinations with real Mongo', () => {
  let sender;
  let current;
  let shared;
  let hidden;

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Promise.all([Pod.deleteMany({}), AgentInstallation.deleteMany({})]);
    [sender, current, shared, hidden] = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
    await Pod.collection.insertMany([
      { _id: current, name: 'Current', members: [sender] },
      { _id: shared, name: 'Review room', members: [sender] },
      { _id: hidden, name: 'Private strategy', members: [new mongoose.Types.ObjectId()] },
    ]);
    await AgentInstallation.collection.insertMany([shared, hidden].map((podId) => ({
      podId, agentName: 'rhea', instanceId: 'default', displayName: 'Rhea', status: 'active',
    })));
  });

  test('returns only shared destinations and hides private names and ids', async () => {
    const notices = await findNonMemberMentionNotices(String(current), '@rhea review this', String(sender));
    expect(notices).toEqual([{
      code: 'MENTION_NOT_IN_POD', handle: 'rhea',
      message: "rhea isn't in this pod. Ask in: Review room.",
      pods: [{ id: String(shared), name: 'Review room' }],
    }]);
    expect(JSON.stringify(notices)).not.toContain(String(hidden));
    expect(JSON.stringify(notices)).not.toContain('Private strategy');
  });

  test('keeps a generic notice for a sender without a shared destination', async () => {
    const notices = await findNonMemberMentionNotices(String(current), '@rhea', String(new mongoose.Types.ObjectId()));
    expect(notices[0]).not.toHaveProperty('pods');
    expect(notices[0].message).toContain("rhea isn't in this pod");
  });

  test('does not warn when the agent is installed in the current pod', async () => {
    await AgentInstallation.collection.insertOne({
      podId: current, agentName: 'rhea', instanceId: 'default', displayName: 'Rhea', status: 'active',
    });
    expect(await findNonMemberMentionNotices(String(current), '@rhea', String(sender))).toEqual([]);
  });
});
