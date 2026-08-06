/**
 * PATCH /api/admin/users/:userId/entitlements — partial patch, incl. `pro`.
 *
 * `pro` is the paid tier: it gates Community listing today and unlimited
 * message history next. Until billing exists this route IS the subscription,
 * so the property that matters most is that a partial patch never silently
 * clears the entitlement it did not name — revoking Pro must not also revoke
 * cloud agents, and vice versa.
 */

const express = require('express');
const request = require('supertest');

// This route file uses CJS `require('express-rate-limit')` while others use
// the ESM default import, so the mock has to be callable AND carry `.default`.
jest.mock('express-rate-limit', () => {
  const factory = () => (_req, _res, next) => next();
  factory.default = factory;
  factory.ipKeyGenerator = (ip) => ip;
  return factory;
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => { req.userId = 'admin-1'; next(); });
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());

const save = jest.fn();
const target = { value: null };

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => Promise.resolve(target.value)),
  find: jest.fn(() => ({ select: jest.fn(() => ({ lean: jest.fn(() => Promise.resolve([])) })) })),
  countDocuments: jest.fn(() => Promise.resolve(0)),
}));

const app = express();
app.use(express.json());
app.use('/api/admin/users', require('../../../routes/admin/users'));

const user = (entitlements) => ({
  _id: 'u-1',
  username: 'someone',
  isBot: false,
  entitlements,
  save,
  toObject() { return { ...this }; },
});

const patch = (body) => request(app).patch('/api/admin/users/u-1/entitlements').send(body);

describe('PATCH /api/admin/users/:userId/entitlements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    save.mockResolvedValue(undefined);
    target.value = user({ cloudAgents: true, pro: false });
  });

  describe('granting and revoking Pro', () => {
    test('grants pro', async () => {
      const res = await patch({ pro: true });
      expect(res.status).toBe(200);
      expect(target.value.entitlements.pro).toBe(true);
      expect(save).toHaveBeenCalled();
    });

    test('revokes pro', async () => {
      target.value = user({ cloudAgents: true, pro: true });
      const res = await patch({ pro: false });
      expect(res.status).toBe(200);
      expect(target.value.entitlements.pro).toBe(false);
    });
  });

  describe('a partial patch never clears the key it did not name', () => {
    // The bug this prevents: revoking a lapsed subscription also silently
    // switching off hosted agents, or granting Pro wiping cloudAgents.
    test('patching pro leaves cloudAgents untouched', async () => {
      await patch({ pro: true });
      expect(target.value.entitlements.cloudAgents).toBe(true);
    });

    test('patching cloudAgents leaves pro untouched', async () => {
      target.value = user({ cloudAgents: false, pro: true });
      await patch({ cloudAgents: true });
      expect(target.value.entitlements.pro).toBe(true);
    });

    test('both keys can move in one call', async () => {
      await patch({ cloudAgents: false, pro: true });
      expect(target.value.entitlements).toMatchObject({ cloudAgents: false, pro: true });
    });
  });

  describe('validation', () => {
    test('an empty body is refused rather than saving nothing', async () => {
      const res = await patch({});
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    });

    test.each([['pro', { pro: 'yes' }], ['cloudAgents', { cloudAgents: 1 }]])(
      'non-boolean %s is refused', async (_k, body) => {
        const res = await patch(body);
        expect(res.status).toBe(400);
        expect(save).not.toHaveBeenCalled();
      },
    );

    test('bots cannot hold entitlements', async () => {
      target.value = { ...user({}), isBot: true };
      const res = await patch({ pro: true });
      expect(res.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    });

    test('a missing user is 404', async () => {
      target.value = null;
      const res = await patch({ pro: true });
      expect(res.status).toBe(404);
    });

    // A pre-existing account has no entitlements object at all.
    test('a user with no entitlements object gets one', async () => {
      target.value = user(undefined);
      const res = await patch({ pro: true });
      expect(res.status).toBe(200);
      expect(target.value.entitlements).toEqual({ pro: true });
    });
  });
});
