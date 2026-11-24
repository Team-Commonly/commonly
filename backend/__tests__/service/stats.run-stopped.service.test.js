// F571 review: run-stopped rows are one per installation and reason, so a
// second stop of the same kind (a new key, refused again) used to write
// nothing, and the page, which only shows a stop made after its latest issue,
// waited forever. A repeat report now moves the row's time to now. Real Mongo
// and the real route: the unique _id is what keeps it one row.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { runStopsFor } = require('../../services/byoTelemetry');
const statsRoutes = require('../../routes/stats');

const settle = () => new Promise((resolve) => { setTimeout(resolve, 50); });
// The route answers 204 before it looks anything up, so wait for the row.
const rowAt = async (match) => {
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const row = await mongoose.connection.db.collection('byo_telemetry').findOne({});
    if (row && match(row)) return row;
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
  throw new Error('no matching run-stopped row');
};

describe('POST /api/stats/run-stopped on real Mongo', () => {
  let app; let owner; let install;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/stats', statsRoutes);
    owner = await User.create({ username: 'f571-owner', email: 'f571@example.test', password: 'x'.repeat(12) });
    const pod = await Pod.create({ name: 'f571', type: 'chat', createdBy: owner._id, members: [owner._id] });
    install = await AgentInstallation.create({
      agentName: 'newbie',
      instanceId: 'default',
      podId: pod._id,
      version: '1',
      installedBy: owner._id,
      status: 'active',
      config: new Map([['runtime', { runtimeType: 'webhook', host: 'byo' }]]),
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await mongoose.connection.db.collection('byo_telemetry').deleteMany({});
  });

  it.each(['token-refused', 'no-token'])('a repeat %s report refreshes the one row, so a later issue still sees it', async (reason) => {
    const post = () => request(app).post('/api/stats/run-stopped')
      .send({ reason, agentName: 'newbie', platform: 'darwin', nodeMajor: 22 });

    await post().expect(204);
    const firstRow = await rowAt(() => true);
    const [first] = await runStopsFor(String(owner._id), [install._id]);
    expect(first.reason).toBe(reason);
    expect(firstRow.at.getTime()).toBeLessThan(Date.now());

    // The page issues a new key after the first stop.
    await settle();
    const issuedAt = Date.now();
    await settle();

    await post().expect(204);
    // Unfixed, the repeat writes nothing and this times out on the old row.
    await rowAt((row) => row.at.getTime() > issuedAt);
    const rows = await runStopsFor(String(owner._id), [install._id]);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].at).getTime()).toBeGreaterThan(issuedAt);
    const stored = await mongoose.connection.db.collection('byo_telemetry').find({}).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      _id: `run-stopped:${install._id}:${reason}`, step: 'run-stopped', reason, platform: 'darwin', nodeMajor: 22,
    });
    expect(String(stored[0].userId)).toBe(String(owner._id));
    expect(String(stored[0].installationId)).toBe(String(install._id));
  });
});
