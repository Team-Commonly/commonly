// TASK-094 (PR A) route tests: the HTTP surface a supervisor uses to mint,
// renew, revoke and sweep per-spawn credentials.
//
// The auth middleware is injected rather than mocked away: it does a Mongo
// lookup and hashes the presented token, and both are covered by
// agentRuntimeAuth.test.js and agentCredential.substrate.test.js. What this
// suite is for is the ROUTE contract — status codes per refusal, that a child
// cannot mint, that the plaintext token is returned once and never stored, and
// that the seat row is only backfilled when the caller has none.
const request = require('supertest');
const express = require('express');
const { Types } = require('mongoose');

let mockAuthState = {};

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = mockAuthState.agentUser;
  req.agentCredential = mockAuthState.agentCredential || null;
  req.agentTokenHash = mockAuthState.agentTokenHash;
  next();
});

jest.mock('../../../models/AgentCredential', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
  AgentRegistry: {},
}));

const AgentCredential = require('../../../models/AgentCredential');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const spawnCredentialRoutes = require('../../../routes/spawnCredentials');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime/spawn-credentials', spawnCredentialRoutes);

const SEAT_ID = new Types.ObjectId();
const AGENT_USER_ID = new Types.ObjectId();

// One chainable shape covers both `findOne().lean()` and the
// `findOne().select(...).lean()` the renew/revoke paths use.
const chain = (value) => {
  const c = { lean: jest.fn(() => Promise.resolve(value)) };
  c.select = jest.fn(() => c);
  return c;
};

const seatRow = (overrides = {}) => ({
  _id: SEAT_ID,
  ownerUserId: AGENT_USER_ID,
  agentUserId: AGENT_USER_ID,
  status: 'active',
  scopes: ['daemon'],
  ...overrides,
});

const asSeat = (row = seatRow()) => {
  mockAuthState = { agentUser: { _id: AGENT_USER_ID }, agentCredential: row, agentTokenHash: 'seat-hash' };
};

describe('POST /api/agents/runtime/spawn-credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asSeat();
    AgentCredential.findOne.mockImplementation(() => chain(seatRow()));
    AgentCredential.updateOne.mockResolvedValue({ modifiedCount: 1 });
    AgentCredential.create.mockResolvedValue({ _id: new Types.ObjectId() });
  });

  test('mints a child for the spawn and returns the plaintext token exactly once', async () => {
    const res = await request(app).post('/api/agents/runtime/spawn-credentials').send({ spawnId: 'spawn-7' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect(res.body.spawnId).toBe('spawn-7');
    expect(new Date(res.body.maxExpiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);

    const row = AgentCredential.create.mock.calls[0][0];
    expect(row.scopes).toEqual(['spawn']);
    expect(row.parentId).toBe(SEAT_ID);
    expect(row.label).toBe('spawn:spawn-7');
    // The plaintext is never stored: only its hash, and it is not the returned value.
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(res.body.token);
  });

  test('the child is bound to the seat row, not to whatever the caller claims', async () => {
    AgentCredential.create.mockResolvedValue({ _id: new Types.ObjectId() });
    const forged = new Types.ObjectId();

    const res = await request(app)
      .post('/api/agents/runtime/spawn-credentials')
      .send({ spawnId: 'spawn-8', parentId: String(forged), scopes: ['daemon'], ownerUserId: String(forged) });

    expect(res.status).toBe(201);
    const row = AgentCredential.create.mock.calls[0][0];
    expect(row.parentId).toBe(SEAT_ID);
    expect(row.ownerUserId).toBe(AGENT_USER_ID);
    expect(row.scopes).toEqual(['spawn']);
  });

  test('a child token cannot mint: a leaked file must not manufacture a longer-lived credential', async () => {
    // A child presents its own hash, so the row the route resolves IS the child.
    asSeat(seatRow({ scopes: ['spawn'] }));
    AgentCredential.findOne.mockImplementation(() => chain(seatRow({ scopes: ['spawn'] })));

    const res = await request(app).post('/api/agents/runtime/spawn-credentials').send({ spawnId: 'spawn-9' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('child_cannot_mint');
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('a missing or oversized spawn id is refused before anything is created', async () => {
    const missing = await request(app).post('/api/agents/runtime/spawn-credentials').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('invalid_spawn_id');

    const oversized = await request(app)
      .post('/api/agents/runtime/spawn-credentials')
      .send({ spawnId: 'x'.repeat(129) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.code).toBe('invalid_spawn_id');
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('an unparseable lifetime is refused rather than defaulted', async () => {
    const res = await request(app)
      .post('/api/agents/runtime/spawn-credentials')
      .send({ spawnId: 'spawn-10', ttlSeconds: 'later' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_ttl');
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('an unauthenticated call is 401, not a mint', async () => {
    mockAuthState = {};

    const res = await request(app).post('/api/agents/runtime/spawn-credentials').send({ spawnId: 'spawn-11' });

    expect(res.status).toBe(401);
    expect(AgentCredential.create).not.toHaveBeenCalled();
  });

  test('a seat that already has a row is not re-derived from an installation', async () => {
    await request(app).post('/api/agents/runtime/spawn-credentials').send({ spawnId: 'spawn-12' });

    expect(AgentInstallation.findOne).not.toHaveBeenCalled();
  });

  test('a legacy seat token with no row is backfilled, using the installation as the owner', async () => {
    const installer = new Types.ObjectId();
    mockAuthState = { agentUser: { _id: AGENT_USER_ID }, agentCredential: null, agentTokenHash: 'legacy-hash' };
    AgentInstallation.findOne.mockReturnValue(chain({ installedBy: installer }));
    // First lookup: nothing there yet. Second: the row the upsert created.
    const backfilled = seatRow({ ownerUserId: installer });
    AgentCredential.findOne
      .mockImplementationOnce(() => chain(null))
      .mockImplementationOnce(() => chain(backfilled));

    const res = await request(app).post('/api/agents/runtime/spawn-credentials').send({ spawnId: 'spawn-13' });

    expect(res.status).toBe(201);
    const insert = AgentCredential.updateOne.mock.calls[0];
    expect(insert[0]).toEqual({ tokenHash: 'legacy-hash' });
    expect(insert[1].$setOnInsert.ownerUserId).toBe(installer);
    expect(insert[2]).toEqual({ upsert: true });
  });
});

describe('renew and revoke', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asSeat();
    AgentCredential.findOne.mockImplementation(() => chain(seatRow()));
    AgentCredential.updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  test('a renewal returns the new expiry and that it extended', async () => {
    const child = new Types.ObjectId();
    AgentCredential.findOne
      .mockImplementationOnce(() => chain(seatRow()))
      .mockImplementationOnce(() => chain({
        _id: child,
        status: 'active',
        expiresAt: new Date(Date.now() + 60 * 1000),
        maxExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }));

    const res = await request(app).post(`/api/agents/runtime/spawn-credentials/${child}/renew`).send({});

    expect(res.status).toBe(200);
    expect(res.body.extended).toBe(true);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 1000);
  });

  test("a renewal for a child that is not this seat's is 404, not a silent success", async () => {
    const stranger = new Types.ObjectId();
    AgentCredential.findOne
      .mockImplementationOnce(() => chain(seatRow()))
      .mockImplementationOnce(() => chain(null));

    const res = await request(app).post(`/api/agents/runtime/spawn-credentials/${stranger}/renew`).send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  test('renewing an expired child is 409: a late renewal must not resurrect it', async () => {
    const child = new Types.ObjectId();
    AgentCredential.findOne
      .mockImplementationOnce(() => chain(seatRow()))
      .mockImplementationOnce(() => chain({
        _id: child,
        status: 'active',
        expiresAt: new Date(Date.now() - 1000),
        maxExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }));

    const res = await request(app).post(`/api/agents/runtime/spawn-credentials/${child}/renew`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_renewable');
    expect(AgentCredential.updateOne).not.toHaveBeenCalled();
  });

  test('a malformed id is 400 on both renew and revoke', async () => {
    const renew = await request(app).post('/api/agents/runtime/spawn-credentials/not-an-id/renew').send({});
    const revoke = await request(app).delete('/api/agents/runtime/spawn-credentials/not-an-id');

    expect(renew.status).toBe(400);
    expect(revoke.status).toBe(400);
  });

  test('revoking a child reports the rows changed, and 404s for one that is not there', async () => {
    const child = new Types.ObjectId();
    AgentCredential.findOne
      .mockImplementationOnce(() => chain(seatRow()))
      .mockImplementationOnce(() => chain({ _id: child, status: 'active' }));

    const ok = await request(app).delete(`/api/agents/runtime/spawn-credentials/${child}`);
    expect(ok.status).toBe(200);
    expect(ok.body.revoked).toBe(1);

    AgentCredential.findOne
      .mockImplementationOnce(() => chain(seatRow()))
      .mockImplementationOnce(() => chain(null));
    const missing = await request(app).delete(`/api/agents/runtime/spawn-credentials/${child}`);
    expect(missing.status).toBe(404);
  });
});

describe('the boot sweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asSeat();
    AgentCredential.updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  test('revokes every active child of the calling seat', async () => {
    AgentCredential.findOne.mockImplementation(() => chain(seatRow()));
    AgentCredential.updateMany.mockResolvedValue({ modifiedCount: 3 });

    const res = await request(app).post('/api/agents/runtime/spawn-credentials/revoke-orphans').send({});

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(3);
    const [filter, update] = AgentCredential.updateMany.mock.calls[0];
    expect(filter).toEqual({ parentId: SEAT_ID, status: 'active' });
    expect(update.$set.status).toBe('revoked');
  });

  test('a legacy seat on its first boot is a clean zero, not a 500', async () => {
    mockAuthState = { agentUser: { _id: AGENT_USER_ID }, agentCredential: null, agentTokenHash: 'legacy-hash' };
    AgentInstallation.findOne.mockReturnValue(chain({ installedBy: AGENT_USER_ID }));
    AgentCredential.findOne
      .mockImplementationOnce(() => chain(null))
      .mockImplementationOnce(() => chain(seatRow()));
    AgentCredential.updateMany.mockResolvedValue({ modifiedCount: 0 });

    const res = await request(app).post('/api/agents/runtime/spawn-credentials/revoke-orphans').send({});

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(0);
    // The upsert is what makes the sweep queryable at all: without it a
    // legacy-only seat has no parentId to sweep by.
    expect(AgentCredential.updateOne.mock.calls[0][2]).toEqual({ upsert: true });
  });
});

describe('GET /policy', () => {
  test('publishes the numbers the cli renews against', async () => {
    jest.clearAllMocks();
    asSeat();

    const res = await request(app).get('/api/agents/runtime/spawn-credentials/policy');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ defaultTtlSeconds: 900, absoluteLifetimeSeconds: 86400, maxSpawnIdLength: 128 });
  });
});
