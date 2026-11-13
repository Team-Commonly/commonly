/**
 * F246 item 5: a comment @mention, delivered through the real mention service.
 *
 * agentThreadComment.test.js stubs AgentMentionService and checks the shape
 * addComment hands it. That stub is what hid F244: the shape looked right, and
 * nothing read the event row routing wrote from it. Here nothing between the
 * comment and the agent's own claim is mocked, so the row the seat claims is the
 * one a real comment produces, and the fields the CLI places its reply by
 * (commentTargetOf in cli/src/commands/agent.js) are read off that row.
 */
process.env.PG_HOST = '';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const model = (m) => m.default || m;
const User = model(require('../../models/User'));
const Pod = model(require('../../models/Pod'));
const Post = model(require('../../models/Post'));
const AgentEvent = model(require('../../models/AgentEvent'));
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const postController = require('../../controllers/postController');

const JWT_SECRET = 'comment-mention-delivery-test-only';
jest.setTimeout(60000);

let app;
let person;
let personToken;
let pod;
let seatToken;

const manifest = (name) => ({
  agentName: name, displayName: name, description: 'comment delivery agent',
  registry: 'commonly-official', verified: true,
  manifest: {
    name, version: '1.0.0', capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] }, runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0', versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

const install = async (agentName) => {
  const installed = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
    .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
  expect(installed.status === 200 ? 200 : installed.body).toBe(200);
  const res = await request(app).post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
    .set('Authorization', `Bearer ${personToken}`).send({ label: `${agentName} token` });
  expect(res.status).toBe(200);
  return res.body.token;
};

const commentOn = async (post, text) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await postController.addComment({
    params: { id: String(post._id) }, body: { text }, userId: String(person._id), user: person,
  }, res);
  expect(res.status).toHaveBeenCalledWith(201);
  return (await Post.findById(post._id).lean()).comments.at(-1);
};

const claim = async () => {
  const res = await request(app).get('/api/agents/runtime/events').set('Authorization', `Bearer ${seatToken}`);
  expect(res.status).toBe(200);
  return res.body.events;
};

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  person = await User.create({ username: 'cmd-person', email: 'cmd-person@test.com', password: 'password123' });
  personToken = jwt.sign({ id: person._id.toString() }, JWT_SECRET);
  await AgentRegistry.create(manifest('alice'));
});

afterAll(closeMongoDb);

beforeEach(async () => {
  await Promise.all([AgentInstallation.deleteMany({}), AgentEvent.deleteMany({}), Post.deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({ name: 'Shared', type: 'chat', createdBy: person._id, members: [person._id] });
  seatToken = await install('alice');
  await AgentEvent.deleteMany({});
});

describe('a comment @mention on a pod post', () => {
  test('reaches the agent as a thread.mention naming the saved comment, with no chat messageId', async () => {
    const post = await Post.create({ userId: person._id, content: 'We shipped it.', podId: pod._id, comments: [] });
    const saved = await commentOn(post, '@alice what does this mean?');

    const rows = await AgentEvent.find({ agentName: 'alice', type: 'thread.mention' }).lean();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(String(row.podId)).toBe(String(pod._id));
    expect(String(row.payload.thread.commentId)).toBe(String(saved._id));
    expect(String(row.payload.thread.postId)).toBe(String(post._id));
    expect(String(row.payload.thread.postPodId)).toBe(String(pod._id));
    // payload.messageId means a Postgres chat row to its readers, and the claim
    // and unanswered-line paths read it as one. A comment must not carry it.
    expect(row.payload.messageId).toBeUndefined();
  });

  test('is what the seat claims, with every field its reply is placed by', async () => {
    const post = await Post.create({ userId: person._id, content: 'We shipped it.', podId: pod._id, comments: [] });
    const saved = await commentOn(post, '@alice what does this mean?');

    const events = await claim();
    const comment = events.find((event) => event.type === 'thread.mention');
    expect(comment).toBeDefined();
    // The CLI's commentTargetOf needs all three, and the post's pod must be the
    // event's pod, or the seat acks without a turn.
    expect(String(comment.payload.thread.postId)).toBe(String(post._id));
    expect(String(comment.payload.thread.commentId)).toBe(String(saved._id));
    expect(String(comment.payload.thread.postPodId)).toBe(String(comment.podId));
    expect(comment.payload.messageId).toBeUndefined();
  });
});
