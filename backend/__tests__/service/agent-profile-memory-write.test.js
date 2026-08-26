const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// This anonymous profile route does not exercise JWT behavior. Mock it so the
// route's unrelated auth-module import stays runnable on Node 26, where this
// repo's legacy jsonwebtoken transitive dependency fails during module load.
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(),
  verify: jest.fn(),
  decode: jest.fn(),
}));

const { MONGO_BINARY_VERSION, MONGOMS_DOWNLOAD_DIR } = require('../utils/mongoBinaryConfig');
const User = require('../../models/User');
const AgentMemory = require('../../models/AgentMemory');
const agentProfileRoutes = require('../../routes/agentProfile');

describe('Agent profile memory activity', () => {
  let app;
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: MONGO_BINARY_VERSION, downloadDir: MONGOMS_DOWNLOAD_DIR, skipMD5: true },
      instance: { dbName: 'agent-profile-memory-write' },
    });
    await mongoose.connect(mongoServer.getUri());
    app = express();
    app.use('/api/agent-profile', agentProfileRoutes);
  });

  afterEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('reports the latest agent-authored section, not a newer system exchange', async () => {
    await User.create({
      username: 'memory-observer',
      email: 'memory-observer@test.com',
      password: 'Password123!',
      isBot: true,
      botMetadata: { agentName: 'claude-code', instanceId: 'observer' },
    });
    await AgentMemory.create({
      agentName: 'claude-code',
      instanceId: 'observer',
      sections: {
        long_term: {
          content: 'Durable review state',
          visibility: 'private',
          updatedAt: new Date('2026-08-26T09:00:00Z'),
        },
        system_exchanges: {
          entries: [],
          visibility: 'private',
          updatedAt: new Date('2026-08-26T10:00:00Z'),
        },
      },
    });

    const res = await request(app).get('/api/agent-profile/claude-code/observer');

    expect(res.status).toBe(200);
    expect(res.body.memory.lastAgentWrite).toEqual({
      section: 'long_term',
      updatedAt: '2026-08-26T09:00:00.000Z',
    });
    expect(res.body.memory.updatedAt).toBeUndefined();
  });
});
