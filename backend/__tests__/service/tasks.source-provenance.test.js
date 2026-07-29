process.env.PG_HOST = '';
process.env.JWT_SECRET = 'tasks-source-provenance-test-secret';

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
const tasksApiRoutes = require('../../routes/tasksApi');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
} = require('../utils/testUtils');

const AGENT_TOKEN = 'cm_agent_task_source_provenance';

describe('POST /api/v1/tasks/:podId source provenance', () => {
  let app;
  let human;
  let agent;
  let pod;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    human = await User.create({
      username: `task-human-${Date.now()}`,
      email: `task-human-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    agent = await User.create({
      username: `task-agent-${Date.now()}`,
      email: `task-agent-${Date.now()}@agents.commonly.local`,
      password: 'Password123!',
      verified: true,
      isBot: true,
      botType: 'agent',
      botMetadata: {
        agentName: 'task-agent',
        instanceId: 'default',
      },
      agentRuntimeTokens: [{
        tokenHash: hash(AGENT_TOKEN),
        label: 'task-source-provenance',
        createdAt: new Date(),
      }],
    });
    pod = await Pod.create({
      name: 'Task provenance pod',
      type: 'team',
      createdBy: human._id,
      members: [human._id, agent._id],
    });
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  it('stamps agent-authenticated creates as agent even when the body claims human', async () => {
    const response = await request(app)
      .post(`/api/v1/tasks/${pod._id}`)
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({
        title: 'Agent-authored task',
        source: 'human',
      })
      .expect(201);

    expect(response.body.task.source).toBe('agent');
    const stored = await Task.findById(response.body.task._id).lean();
    expect(stored.source).toBe('agent');
  });

  it('preserves the existing source override for human-authenticated imports', async () => {
    const response = await request(app)
      .post(`/api/v1/tasks/${pod._id}`)
      .set('Authorization', `Bearer ${generateTestToken(human._id)}`)
      .send({
        title: 'Imported task',
        source: 'github',
        sourceRef: 'GH#999',
      })
      .expect(201);

    expect(response.body.task.source).toBe('github');
  });
});
