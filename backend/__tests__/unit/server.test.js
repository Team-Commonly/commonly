/* eslint-disable global-require */
const request = require('supertest');
const express = require('express');

jest.mock('../../config/db', () => jest.fn());
jest.mock('../../models/Pod', () => ({
  findById: jest.fn(),
}));
jest.mock('../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});
jest.mock('../../controllers/podController', () => ({
  getAllPods: jest.fn((req, res) => res.status(200).end()),
  getPodsByType: jest.fn((req, res) => res.status(200).end()),
  getPodById: jest.fn((req, res) => res.status(404).json({ error: 'Pod not found' })),
  createPod: jest.fn((req, res) => res.status(201).end()),
  joinPod: jest.fn((req, res) => res.status(200).end()),
  leavePod: jest.fn((req, res) => res.status(200).end()),
  removeMember: jest.fn((req, res) => res.status(200).end()),
  deletePod: jest.fn((req, res) => res.status(200).end()),
}));

const mockInviteFind = jest.fn();
jest.mock('../../models/PodInvite', () => ({
  PodInvite: {
    find: (...args) => mockInviteFind(...args),
    findOne: jest.fn(),
    create: jest.fn(),
  },
}));

const mockConnectPG = jest.fn().mockResolvedValue(null);
jest.mock('../../config/db-pg', () => ({ connectPG: mockConnectPG }));
const mockInitPGDB = jest.fn();
jest.mock('../../config/init-pg-db', () => mockInitPGDB);

// Replace pg routes with simple routers
jest.mock('../../routes/pg-status', () => {
  const ex = require('express');
  const r = ex.Router();
  r.get('/', (req, res) => res.json({ available: true }));
  return r;
});
jest.mock('../../routes/pg-messages', () => {
  const ex = require('express');
  const r = ex.Router();
  r.get('/', (req, res) => res.json({ mounted: true }));
  return r;
});

/**
 * TASK-168. The production failure being pinned here: one timed-out connect at
 * boot used to decide PostgreSQL's fate for the pod's whole life, so on
 * 2026-09-25 the only replica served without chat history (`/api/pg/messages`
 * 404, pg-retention and installation-cleanup never started) until a human did a
 * rollout restart, on an image that was fine and against a PG that answered a
 * probe in 331ms.
 *
 * What server.ts owns is the WIRING: retry, and mount the message routes only
 * once connect AND schema initialization have both succeeded. What the routes
 * themselves answer is mocked here on purpose — the point is which router, if
 * any, is on the path.
 */
describe('server pg boot routes', () => {
  // Every case here re-requires server.ts (`jest.resetModules` between them,
  // because PG_HOST decides the boot path), and that module loads ~50 routers,
  // mongoose, socket.io and Sentry. Alone that is ~6s; inside a full parallel
  // run — 451 suites on a loaded machine — it went past jest's 30s default and
  // reported a timeout, not a failure. The budget is explicit rather than
  // inherited so a genuine hang still shows up as a timeout, at 2x the headroom
  // the loaded case needed.
  jest.setTimeout(60000);

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.PG_HOST;
    delete process.env.PG_BOOT_RETRY_BASE_DELAY_MS;
  });

  it('mounts the real status router even when PG is not configured', async () => {
    delete process.env.PG_HOST;
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    const res = await request(app).get('/api/pg/status');

    // This mocked router can only ever answer available:true, so getting its
    // answer back is the proof that the real router is what serves this path.
    // The placeholder `{ available: false }` handlers it replaces would win
    // instead, because Express serves the first registered match — and those
    // placeholders could never tell the truth after a late mount anyway.
    expect(res.body).toEqual({ available: true });
  });

  it('leaves the message routes unmounted while the boot connect keeps failing', async () => {
    process.env.PG_HOST = 'x';
    process.env.PG_BOOT_RETRY_BASE_DELAY_MS = '1';
    mockConnectPG.mockResolvedValue(null);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    await request(app).get('/api/pg/messages').expect(404);
  });

  it('retries the boot connect and mounts the message routes when a later attempt succeeds', async () => {
    process.env.PG_HOST = 'x';
    process.env.PG_BOOT_RETRY_BASE_DELAY_MS = '1';
    mockConnectPG
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValue({});
    mockInitPGDB.mockResolvedValue(true);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    await request(app).get('/api/pg/messages').expect(200);
    expect(mockConnectPG).toHaveBeenCalledTimes(2);
    expect(mockInitPGDB).toHaveBeenCalledTimes(1);
  });

  it('does not mount the message routes when the schema initialization fails', async () => {
    process.env.PG_HOST = 'x';
    process.env.PG_BOOT_RETRY_BASE_DELAY_MS = '1';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockResolvedValue(false);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    await request(app).get('/api/pg/messages').expect(404);
  });
});

describe('server route precedence', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('routes pod invite lists before the pods catch-all route', async () => {
    const podId = '507f1f77bcf86cd799439011';
    const token = 'a'.repeat(32);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const Pod = require('../../models/Pod');
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { getPodById } = require('../../controllers/podController');
    Pod.findById.mockResolvedValue({
      _id: podId,
      createdBy: 'owner',
      members: ['user1'],
    });
    mockInviteFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([{
            token,
            createdBy: { _id: 'user1', username: 'member' },
            createdAt: new Date('2026-07-22T12:00:00Z'),
            expiresAt: null,
            maxUses: null,
            useCount: 0,
          }]),
        }),
      }),
    });

    // Requiring the real app is load-bearing: both pod routers are mounted in
    // server.ts order, so this test catches the production-only shadowing bug.
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    const res = await request(app).get(`/api/pods/${podId}/invites`).expect(200);

    expect(mockInviteFind).toHaveBeenCalledWith({ podId, revokedAt: null });
    expect(getPodById).not.toHaveBeenCalled();
    expect(res.body).toEqual([
      expect.objectContaining({ token, uses: 0 }),
    ]);
  });
});

describe('server websocket authorization helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('treats string and ObjectId-like members as valid pod members', () => {
    jest.resetModules();
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { isPodMember } = require('../../server');

    expect(
      isPodMember(
        {
          members: [
            { toString: () => 'user-1' },
            { toString: () => 'user-2' },
          ],
        },
        'user-2',
      ),
    ).toBe(true);
  });

  it('rejects socket pod joins for non-members', async () => {
    jest.resetModules();
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const Pod = require('../../models/Pod');
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { authorizeSocketPodAccess } = require('../../server');
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      members: [{ toString: () => 'user-2' }],
    });
    const socket = {
      userId: 'user-1',
      emit: jest.fn(),
    };

    const result = await authorizeSocketPodAccess(socket, 'pod-1', 'join');

    expect(result).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      message: 'Not authorized to join for this pod',
    });
  });

  it('allows socket pod access for members', async () => {
    jest.resetModules();
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const Pod = require('../../models/Pod');
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { authorizeSocketPodAccess } = require('../../server');
    const pod = {
      _id: 'pod-1',
      members: [{ toString: () => 'user-1' }],
    };
    Pod.findById.mockResolvedValue(pod);
    const socket = {
      userId: 'user-1',
      emit: jest.fn(),
    };

    const result = await authorizeSocketPodAccess(socket, 'pod-1', 'post');

    expect(result).toBe(pod);
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
