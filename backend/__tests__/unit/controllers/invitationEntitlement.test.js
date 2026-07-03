const User = require('../../../models/User');
const InvitationCode = require('../../../models/InvitationCode');
const authController = require('../../../controllers/authController');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

// Invitation codes stopped gating signup and started granting the
// hosted-agent entitlement (2026-07-03 plan revision). These tests pin the
// new semantics across password registration and post-signup redemption.

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));

const mockRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});

const seedDbCode = async (code = 'BETA1', maxUses = 1) => {
  const admin = await User.findOne({ username: 'seed-admin' })
    || await User.create({
      username: 'seed-admin',
      email: 'seed-admin@example.com',
      password: 'hashed',
      role: 'admin',
    });
  return InvitationCode.create({
    code,
    isActive: true,
    maxUses,
    useCount: 0,
    createdBy: admin._id,
  });
};

describe('Invitation → cloudAgents entitlement', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(() => {
    // Open registration; no SMTP → auto-verify path.
    process.env.REGISTRATION_INVITE_ONLY = 'false';
    delete process.env.REGISTRATION_INVITE_CODES;
    delete process.env.SMTP2GO_API_KEY;
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    delete process.env.REGISTRATION_INVITE_ONLY;
    delete process.env.REGISTRATION_INVITE_CODES;
  });

  describe('register (open registration)', () => {
    const registerReq = (overrides = {}) => ({
      body: {
        username: 'newbie',
        email: 'newbie@example.com',
        password: 'Password123!',
        ...overrides,
      },
    });

    it('grants cloudAgents when a valid DB code is provided, and consumes it', async () => {
      await seedDbCode('BETA1');
      const res = mockRes();

      await authController.register(registerReq({ invitationCode: 'BETA1' }), res);

      expect(res.status).toHaveBeenCalledWith(201);
      const user = await User.findOne({ email: 'newbie@example.com' });
      expect(user.entitlements.cloudAgents).toBe(true);
      const invite = await InvitationCode.findOne({ code: 'BETA1' });
      expect(invite.useCount).toBe(1);
    });

    it('grants cloudAgents via a reusable env code', async () => {
      process.env.REGISTRATION_INVITE_CODES = 'LAUNCH-CREW';
      const res = mockRes();

      await authController.register(registerReq({ invitationCode: 'LAUNCH-CREW' }), res);

      const user = await User.findOne({ email: 'newbie@example.com' });
      expect(user.entitlements.cloudAgents).toBe(true);
    });

    it('creates a BYO-only account when no code is given', async () => {
      const res = mockRes();

      await authController.register(registerReq(), res);

      expect(res.status).toHaveBeenCalledWith(201);
      const user = await User.findOne({ email: 'newbie@example.com' });
      expect(user.entitlements.cloudAgents).toBe(false);
    });

    it('fails loudly on a provided-but-invalid code even though registration is open', async () => {
      const res = mockRes();

      await authController.register(registerReq({ invitationCode: 'NOPE' }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVITATION_INVALID' }));
      expect(await User.countDocuments({ email: 'newbie@example.com' })).toBe(0);
    });

    it('still gates signup when invite-only mode is on', async () => {
      process.env.REGISTRATION_INVITE_ONLY = 'true';
      await seedDbCode('BETA1');
      const res = mockRes();

      await authController.register(registerReq(), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVITATION_REQUIRED' }));
    });
  });

  describe('redeemInvitation (post-signup upgrade)', () => {
    const makeUser = (entitled = false) => User.create({
      username: 'byo-user',
      email: 'byo@example.com',
      password: 'hashed',
      verified: true,
      entitlements: { cloudAgents: entitled },
    });

    it('flips cloudAgents on a valid code', async () => {
      const user = await makeUser();
      await seedDbCode('UPGRADE1');
      const res = mockRes();

      await authController.redeemInvitation(
        { userId: user._id, body: { invitationCode: 'UPGRADE1' } },
        res,
      );

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        entitlements: expect.objectContaining({ cloudAgents: true }),
      }));
      const fresh = await User.findById(user._id);
      expect(fresh.entitlements.cloudAgents).toBe(true);
    });

    it('rejects an invalid code', async () => {
      const user = await makeUser();
      const res = mockRes();

      await authController.redeemInvitation(
        { userId: user._id, body: { invitationCode: 'BOGUS' } },
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      const fresh = await User.findById(user._id);
      expect(fresh.entitlements.cloudAgents).toBe(false);
    });

    it('does not burn a code use on an already-entitled account', async () => {
      const user = await makeUser(true);
      await seedDbCode('PRECIOUS', 1);
      const res = mockRes();

      await authController.redeemInvitation(
        { userId: user._id, body: { invitationCode: 'PRECIOUS' } },
        res,
      );

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('already unlocked'),
      }));
      const invite = await InvitationCode.findOne({ code: 'PRECIOUS' });
      expect(invite.useCount).toBe(0);
    });
  });
});
