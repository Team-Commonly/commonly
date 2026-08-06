/**
 * POST /api/pods/:id/visibility — owner-writable Community tier (#768).
 *
 * Before this route, `communityListed` was settable only from
 * routes/admin/pods.ts behind adminAuth, so the creation flow's most prominent
 * choice was inert for every non-admin: picking "Open to join" produced
 * joinPolicy:'open' on a pod nobody could discover, because self-joinable is
 * `community AND open` and a normal user could not reach community.
 *
 * The invariant these tests defend is ADR-016 #1 — listed => readable — which
 * this route satisfies by writing BOTH flags in one action rather than
 * offering the admin surface's two steps.
 */

const express = require('express');
const request = require('supertest');

// The route's own limiter is 10/hour per IP — correct in production, and it
// would 429 partway through this suite since every request shares one IP.
// Stubbed to a pass-through so the tests exercise the handler; the limiter's
// presence is asserted separately below.
jest.mock('express-rate-limit', () => {
  const factory = () => (_req, _res, next) => next();
  factory.ipKeyGenerator = (ip) => ip;
  return { __esModule: true, default: factory, ipKeyGenerator: factory.ipKeyGenerator };
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = req.headers['x-test-user'] || 'owner-1';
  next();
});

const podSave = jest.fn();
const mockPod = { value: null };

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => Promise.resolve(mockPod.value)),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({
    select: jest.fn(() => ({ lean: jest.fn(() => Promise.resolve({ role: 'user' })) })),
  })),
}));

jest.mock('../../../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve()) }));

// Route module pulls in a wide surface; stub the parts irrelevant here.
jest.mock('../../../controllers/podController', () => ({
  getAllPods: (_q, res) => res.json([]),
  getPodsByType: (_q, res) => res.json([]),
  getPodById: (_q, res) => res.json({}),
  createPod: (_q, res) => res.json({}),
  joinPod: (_q, res) => res.json({}),
  leavePod: (_q, res) => res.json({}),
  removeMember: (_q, res) => res.json({}),
  deletePod: (_q, res) => res.json({}),
}));

const AuditLog = require('../../../models/AuditLog');

const app = express();
app.use(express.json());
app.use('/api/pods', require('../../../routes/pods'));

const pod = (over = {}) => ({
  _id: 'pod-1',
  type: 'chat',
  publicRead: false,
  communityListed: false,
  createdBy: 'owner-1',
  save: podSave,
  ...over,
});

const setVisibility = (tier, user = 'owner-1') => request(app)
  .post('/api/pods/pod-1/visibility')
  .set('x-test-user', user)
  .send({ tier });

describe('POST /api/pods/:id/visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    podSave.mockResolvedValue(undefined);
    mockPod.value = pod();
  });

  describe('the owner can finally reach Community — the #768 fix', () => {
    test('promoting sets BOTH flags in one write', async () => {
      const res = await setVisibility('community');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tier: 'community', publicRead: true, communityListed: true });
      expect(mockPod.value.publicRead).toBe(true);
      expect(mockPod.value.communityListed).toBe(true);
      expect(podSave).toHaveBeenCalledTimes(1);
    });

    // The whole point. A two-step owner flow would 409 forever on
    // listing_requires_public_read, because publicRead (showcase) is admin-only.
    test('never leaves the pod listed-but-unreadable (ADR-016 invariant 1)', async () => {
      await setVisibility('community');
      expect(mockPod.value.communityListed && !mockPod.value.publicRead).toBe(false);
    });

    test('demoting to private clears both', async () => {
      mockPod.value = pod({ publicRead: true, communityListed: true });
      const res = await setVisibility('private');
      expect(res.status).toBe(200);
      expect(mockPod.value.publicRead).toBe(false);
      expect(mockPod.value.communityListed).toBe(false);
    });
  });

  describe('showcase stays admin-only', () => {
    // publicRead without listing publishes every future message to anonymous
    // readers. Owners get the two ends of the ladder, not the curated middle.
    test('tier "showcase" is rejected', async () => {
      const res = await setVisibility('showcase');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_tier');
      expect(podSave).not.toHaveBeenCalled();
    });

    test('garbage tiers are rejected without writing', async () => {
      for (const t of ['public', '', null, 'COMMUNITY']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await setVisibility(t);
        expect(res.status).toBe(400);
      }
      expect(podSave).not.toHaveBeenCalled();
    });
  });

  describe('who may call it', () => {
    test('a non-owner non-admin is refused', async () => {
      const res = await setVisibility('community', 'someone-else');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not_pod_owner');
      expect(podSave).not.toHaveBeenCalled();
    });

    test('a global admin may act on a pod they do not own', async () => {
      const User = require('../../../models/User');
      User.findById.mockReturnValue({
        select: jest.fn(() => ({ lean: jest.fn(() => Promise.resolve({ role: 'admin' })) })),
      });
      const res = await setVisibility('community', 'admin-9');
      expect(res.status).toBe(200);
    });

    test('a missing pod is 404, not a silent success', async () => {
      mockPod.value = null;
      const res = await setVisibility('community');
      expect(res.status).toBe(404);
    });
  });

  describe('DM kinds stay terminally private', () => {
    test.each(['agent-room', 'agent-dm', 'agent-admin'])('%s cannot be listed', async (type) => {
      mockPod.value = pod({ type });
      const res = await setVisibility('community');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('pod_type_not_listable');
      expect(podSave).not.toHaveBeenCalled();
    });
  });

  describe('publishing is audited', () => {
    test('promotion writes a community.list audit row naming the owner', async () => {
      await setVisibility('community');
      expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'community.list',
        target: 'pod-1',
        userId: 'owner-1',
      }));
    });

    test('demotion writes community.unlist', async () => {
      mockPod.value = pod({ publicRead: true, communityListed: true });
      await setVisibility('private');
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'community.unlist' }),
      );
    });

    // Audit is best-effort; losing the row must not lose the visibility change.
    test('an audit failure does not fail the request', async () => {
      AuditLog.create.mockRejectedValue(new Error('audit down'));
      const res = await setVisibility('community');
      expect(res.status).toBe(200);
    });
  });

  // The limiter is stubbed above, so its wiring needs its own check: publishing
  // is the one owner action that exposes content to non-members, and it must
  // not be callable in a tight loop.
  describe('the route is rate-limited', () => {
    test('a limiter middleware sits in front of the handler', () => {
      const layer = require('../../../routes/pods').stack
        .find((l) => l.route && l.route.path === '/:id/visibility');
      expect(layer).toBeTruthy();
      // auth + limiter + handler — more than just auth and the handler.
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(3);
    });
  });
});
