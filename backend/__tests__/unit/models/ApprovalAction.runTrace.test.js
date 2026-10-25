const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const ApprovalAction = require('../../../models/ApprovalAction');

beforeAll(setupMongoDb);
afterAll(closeMongoDb);

test('the originating run persists across an approval save, reload and transition', async () => {
  const runId = new mongoose.Types.ObjectId();
  const runPodId = new mongoose.Types.ObjectId();
  const action = await ApprovalAction.create({
    podId: new mongoose.Types.ObjectId(), ownerUserId: new mongoose.Types.ObjectId(),
    agentName: 'trace-seat', actionType: 'create_pod', params: { name: 'Research' },
    summary: 'Create a research pod', runId, runPodId,
  });
  const loaded = await ApprovalAction.findById(action._id);
  expect(String(loaded.runId)).toBe(String(runId));
  expect(String(loaded.runPodId)).toBe(String(runPodId));
  loaded.status = 'resolved';
  loaded.decision = 'declined';
  await loaded.save();
  const resolved = await ApprovalAction.findById(action._id).lean();
  expect(String(resolved.runId)).toBe(String(runId));
  expect(String(resolved.runPodId)).toBe(String(runPodId));
  expect(resolved.status).toBe('resolved');
});
