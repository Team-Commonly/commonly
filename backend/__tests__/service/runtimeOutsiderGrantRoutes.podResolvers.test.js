// The stored-record pod resolvers against real documents rather than a mocked
// find: each has to select the field that holds the pod, or the classifier
// sees no pod and treats a pod write as outward.
process.env.PG_HOST = '';

const mongoose = require('mongoose');
const Post = require('../../models/Post');
const AgentAsk = require('../../models/AgentAsk');
const { classifyRuntimeOutsiderGrantRoute } = require('../../services/runtimeOutsiderGrantRoutes');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

const model = (m) => m.default || m;
const id = () => new mongoose.Types.ObjectId();
const classify = (path, params) => classifyRuntimeOutsiderGrantRoute({
  baseUrl: '/api/agents/runtime', method: 'POST', route: { path }, params, body: { podId: String(id()) },
});

describe('runtime outsider grant pod resolvers', () => {
  beforeAll(setupMongoDb);
  afterEach(clearMongoDb);
  afterAll(closeMongoDb);

  test('a thread comment resolves the pod stored on its post', async () => {
    const podId = id();
    const post = await model(Post).create({ podId, userId: id(), content: 'in a pod' });
    await expect(classify('/threads/:threadId/comments', { threadId: String(post._id) }))
      .resolves.toEqual({ routeClass: 'pod_write', podId: String(podId) });

    const global = await model(Post).create({ podId: null, userId: id(), content: 'global' });
    await expect(classify('/threads/:threadId/comments', { threadId: String(global._id) }))
      .resolves.toEqual({ routeClass: 'outward', podId: null });
  });

  test('an ask response resolves the pod stored on its ask', async () => {
    const podId = id();
    await model(AgentAsk).create({
      requestId: 'ask-resolver', podId, fromAgent: 'asker', targetAgent: 'answerer', question: 'which pod?',
    });
    await expect(classify('/asks/:requestId/respond', { requestId: 'ask-resolver' }))
      .resolves.toEqual({ routeClass: 'pod_write', podId: String(podId) });
  });
});
