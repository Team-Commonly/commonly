const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const marketplaceRouter = require('../routes/marketplace');
const AgentManifest = require('../models/AgentManifest');
const { setupMongoDb, teardownMongoDb, clearMongoDb } = require('../__tests__/utils/testUtils');

jest.mock('../middleware/auth', () => {
  const mockMongoose = require('mongoose');
  return (req, _res, next) => {
    req.user = { _id: new mockMongoose.Types.ObjectId() };
    next();
  };
});

const app = express();
app.use(express.json());
app.use('/api/marketplace', marketplaceRouter);

beforeAll(async () => {
  await setupMongoDb();
});

beforeEach(async () => {
  await clearMongoDb();
});

afterAll(async () => {
  await teardownMongoDb();
});

describe('marketplace routes', () => {
  test('lists only public agents', async () => {
    await AgentManifest.create({
      name: 'Public Agent', slug: 'public-agent', version: '1.0.0', author: 'Nova', runtimeType: 'internal', owner: new mongoose.Types.ObjectId(), isPublic: true,
    });
    await AgentManifest.create({
      name: 'Private Agent', slug: 'private-agent', version: '1.0.0', author: 'Nova', runtimeType: 'internal', owner: new mongoose.Types.ObjectId(), isPublic: false,
    });

    const res = await request(app).get('/api/marketplace/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].slug).toBe('public-agent');
  });

  test('registers a manifest when authenticated', async () => {
    const res = await request(app).post('/api/marketplace/agents/register').send({
      name: 'My Agent', slug: 'My-Agent', version: '1.0.0', author: 'Nova', runtimeType: 'webhook', webhookUrl: 'https://example.com', capabilities: ['chat'], isPublic: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.agent.slug).toBe('my-agent');
  });

  test('rejects invalid manifest payloads', async () => {
    const res = await request(app).post('/api/marketplace/agents/register').send({ slug: 'bad' });
    expect(res.status).toBe(400);
  });

  test('gets a manifest by slug', async () => {
    await AgentManifest.create({
      name: 'Lookup Agent', slug: 'lookup-agent', version: '1.0.0', author: 'Nova', runtimeType: 'internal', owner: new mongoose.Types.ObjectId(), isPublic: true,
    });

    const res = await request(app).get('/api/marketplace/agents/lookup-agent');
    expect(res.status).toBe(200);
    expect(res.body.agent.slug).toBe('lookup-agent');
  });

  test('forbids updates from non-owners', async () => {
    const owner = new mongoose.Types.ObjectId();
    await AgentManifest.create({
      name: 'Owned Agent', slug: 'owned-agent', version: '1.0.0', author: 'Nova', runtimeType: 'internal', owner, isPublic: true,
    });

    const res = await request(app).put('/api/marketplace/agents/owned-agent').send({ description: 'changed' });
    expect(res.status).toBe(403);
  });
});
