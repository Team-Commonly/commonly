/**
 * AgentRegistry-only write paths mirror an Installable row, best-effort: the
 * mirror inserts when missing, never overwrites, and never fails the request.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Installable = require('../../models/Installable');
const { AgentRegistry } = require('../../models/AgentRegistry');
const { mirrorRegistryAvatar } = require('../../services/installable/registryReconciler');

const JWT_SECRET = 'test-jwt-secret-registry-mirror';

jest.setTimeout(60000);

describe('registry write paths mirror an Installable', () => {
  let app;
  let token;
  let user;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    await Installable.init();
    app = express();
    app.use(express.json());
    app.use('/api/registry', require('../../routes/registry'));
  });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    user = await User.create({ username: 'dev-alice', email: 'alice@test.com', password: 'password123' });
    token = jwt.sign({ id: user._id }, JWT_SECRET);
  });

  test('POST /seed inserts the seeded agents into Installable', async () => {
    const res = await request(app).post('/api/registry/seed').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = await Installable.find({}).sort({ installableId: 1 }).lean();
    expect(rows.map((r) => r.installableId)).toEqual(['commonly-bot', 'openclaw']);
    expect(rows[0]).toMatchObject({ source: 'builtin', marketplace: { verified: true } });
  });

  test('POST /publish inserts an unverified, unpublished Installable', async () => {
    const res = await request(app)
      .post('/api/registry/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ manifest: { name: 'alice-helper', version: '1.0.0', description: 'Helps.' } });
    expect(res.status).toBe(200);
    const row = await Installable.findOne({ installableId: 'alice-helper' }).lean();
    expect(row).toMatchObject({ source: 'marketplace', marketplace: { published: false, verified: false } });
  });

  test('a mirror never overwrites an existing Installable', async () => {
    await Installable.create({
      installableId: 'commonly-bot',
      name: 'Kept',
      description: 'kept',
      version: '9.9.9',
      kind: 'app',
      source: 'builtin',
      scope: 'instance',
    });
    const before = await Installable.collection.findOne({ installableId: 'commonly-bot' });
    await request(app).post('/api/registry/seed').set('Authorization', `Bearer ${token}`).expect(200);
    expect(await Installable.collection.findOne({ installableId: 'commonly-bot' })).toEqual(before);
  });

  test('a mirror failure does not fail the request', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(Installable, 'updateOne').mockRejectedValue(new Error('installable down'));
    try {
      const res = await request(app).post('/api/registry/seed').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(await AgentRegistry.countDocuments()).toBe(2);
      expect(await Installable.countDocuments()).toBe(0);
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('[installable-mirror]'))).toBe(true);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  test('the avatar mirror changes only an existing backfilled row, guarded by its old value', async () => {
    const avatarOf = async (id) => {
      const row = await Installable.findOne({ installableId: id }).lean();
      return row.components[0].persona.avatar;
    };
    await mirrorRegistryAvatar('nobody', 'bottts:x');
    expect(await Installable.countDocuments()).toBe(0);

    await Installable.create({
      installableId: 'pixel',
      name: 'Pixel',
      description: 'd',
      version: '1.0.0',
      kind: 'agent',
      source: 'builtin',
      scope: 'instance',
      components: [{ name: 'pixel', type: 'agent', persona: { avatar: 'bottts:a' } }],
      origin: 'registry-backfill',
    });
    await mirrorRegistryAvatar('pixel', '', 'bottts:other');
    expect(await avatarOf('pixel')).toBe('bottts:a');
    await mirrorRegistryAvatar('pixel', 'bottts:b');
    expect(await avatarOf('pixel')).toBe('bottts:b');
    await mirrorRegistryAvatar('pixel', '', 'bottts:b');
    expect(await avatarOf('pixel')).toBe('');
  });
});
