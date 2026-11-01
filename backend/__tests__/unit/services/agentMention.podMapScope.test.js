/**
 * loadPodMentionMap reads one pod's installs from a real in-memory Mongo, both
 * when it is given the pod's ObjectId (welcomeWakeService passes one) and when
 * it is given the hex string. A mocked find returns rows whatever the query
 * says, so it cannot show that the `$eq` on the hex string is cast to the
 * ObjectId field and stays inside the pod.
 */
const mongoose = require('mongoose');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { loadPodMentionMap } = require('../../../services/agentMentionService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('loadPodMentionMap pod scope (in-memory Mongo)', () => {
  const podA = new mongoose.Types.ObjectId();
  const podB = new mongoose.Types.ObjectId();
  const installedBy = new mongoose.Types.ObjectId();

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    await AgentInstallation.create([
      { agentName: 'codex', instanceId: 'rivet', displayName: 'Rivet', podId: podA, version: '1.0.0', installedBy },
      { agentName: 'claude', instanceId: 'tern', displayName: 'Tern', podId: podB, version: '1.0.0', installedBy },
    ]);
  });

  it.each([
    ['its ObjectId', () => podA],
    ['its hex string', () => podA.toHexString()],
  ])('given %s, holds that pod\'s handles and none of the other pod\'s', async (_label, podId) => {
    const map = await loadPodMentionMap(podId());

    expect(map.has('codex-rivet')).toBe(true);
    for (const key of ['claude', 'claude-tern', 'tern']) expect(map.has(key)).toBe(false);
  });
});
