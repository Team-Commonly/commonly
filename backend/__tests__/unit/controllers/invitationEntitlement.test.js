const User = require('../../../models/User');
const InvitationCode = require('../../../models/InvitationCode');
const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');

jest.mock('../../../services/communityPodService', () => ({
  ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined),
}));
const { ensureUserInCommunityPod } = require('../../../services/communityPodService');
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
      expect(user.verified).toBe(true);
      expect(ensureUserInCommunityPod).toHaveBeenCalledWith(user._id);
    });

    it('fails loudly on a provided-but-invalid code even though registration is open', async () => {
      const res = mockRes();

      await authController.register(registerReq({ invitationCode: 'NOPE' }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVITATION_INVALID' }));
      expect(await User.countDocuments({ email: 'newbie@example.com' })).toBe(0);
    });

    it('seeds the starter workspace: default pod + 3 onboarding checklist tasks', async () => {
      const res = mockRes();

      await authController.register(registerReq(), res);

      const user = await User.findOne({ email: 'newbie@example.com' });
      const pod = await Pod.findOne({ createdBy: user._id });
      expect(pod).toBeTruthy();
      expect(pod.name).toBe('My Workspace');

      const tasks = await Task.find({ podId: pod._id }).sort({ taskNum: 1 });
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.taskId)).toEqual(['TASK-001', 'TASK-002', 'TASK-003']);
      expect(tasks[0].title).toMatch(/connect your first agent/i);
      expect(tasks.every((t) => t.source === 'onboarding' && t.status === 'pending')).toBe(true);
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

  describe('password reset', () => {
    // These use the REAL jwt (unmocked would be ideal, but the file-level
    // mock returns static values) — so exercise the flow via the controller
    // with the mock steering decode/verify.
    const jwt = require('jsonwebtoken');

    const makeUser = () => User.create({
      username: 'resetter',
      email: 'resetter@example.com',
      password: 'old-hashed',
      verified: false,
    });

    it('forgot-password always answers generically (no account enumeration)', async () => {
      const res = mockRes();
      await authController.forgotPassword({ body: { email: 'nobody@example.com' } }, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('If that email has an account'),
      }));
    });

    it('reset with a valid token updates the password and marks verified', async () => {
      const user = await makeUser();
      jwt.decode = jest.fn().mockReturnValue({ id: String(user._id), purpose: 'password-reset' });
      jwt.verify = jest.fn().mockReturnValue({ id: String(user._id) });

      const res = mockRes();
      await authController.resetPassword({ body: { token: 't', password: 'brand-new-pass-1' } }, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Password updated'),
      }));
      const fresh = await User.findById(user._id);
      expect(fresh.verified).toBe(true);
      expect(fresh.password).not.toBe('old-hashed');
      expect(ensureUserInCommunityPod).toHaveBeenCalledWith(user._id);
    });

    it('rejects tokens with the wrong purpose and short passwords', async () => {
      const user = await makeUser();
      jwt.decode = jest.fn().mockReturnValue({ id: String(user._id), purpose: 'email-verify' });
      const res = mockRes();
      await authController.resetPassword({ body: { token: 't', password: 'brand-new-pass-1' } }, res);
      expect(res.status).toHaveBeenCalledWith(400);

      const res2 = mockRes();
      await authController.resetPassword({ body: { token: 't', password: 'short' } }, res2);
      expect(res2.status).toHaveBeenCalledWith(400);
    });

    it('rejects when signature verification fails (used/expired token)', async () => {
      const user = await makeUser();
      // The pre-save hook hashed the seed password; capture the stored hash
      // as the unchanged-baseline rather than the raw seed string.
      const storedHash = (await User.findById(user._id)).password;
      jwt.decode = jest.fn().mockReturnValue({ id: String(user._id), purpose: 'password-reset' });
      jwt.verify = jest.fn().mockImplementation(() => { throw new Error('invalid signature'); });

      const res = mockRes();
      await authController.resetPassword({ body: { token: 't', password: 'brand-new-pass-1' } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      const fresh = await User.findById(user._id);
      expect(fresh.password).toBe(storedHash);
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
