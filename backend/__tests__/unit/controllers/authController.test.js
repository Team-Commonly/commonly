const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../../../models/User');
const WaitlistRequest = require('../../../models/WaitlistRequest');
const { AgentRegistry } = require('../../../models/AgentRegistry');

jest.mock('../../../services/communityPodService', () => ({
  ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ data: { succeeded: 1 } }),
}));
// The workspace onboarding tail (TASK-149) is queued off the register response
// path, so a unit suite has to hold it still: the checklist is the step the test
// below parks on, and the PG mirror is stubbed here so no test in this file
// depends on whether the runner happens to export PG_HOST.
jest.mock('../../../models/Task', () => ({ create: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../services/pgPodSyncService', () => ({
  syncPodFromMongo: jest.fn().mockResolvedValue({}),
}));
const { ensureUserInCommunityPod } = require('../../../services/communityPodService');
const { sendEmail } = require('../../../services/emailService');
const Task = require('../../../models/Task');
const Pod = require('../../../models/Pod');
const authController = require('../../../controllers/authController');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

// Mock SendGrid to prevent actual emails from being sent
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue(true),
}));

// Mock Bcrypt
jest.mock('bcryptjs', () => ({
  genSalt: jest.fn().mockResolvedValue('mocksalt'),
  hash: jest.fn().mockResolvedValue('hashedPassword'),
  compare: jest.fn().mockResolvedValue(true),
}));

// Mock JWT
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn().mockReturnValue({ id: 'mockUserId' }),
}));

describe('Auth Controller Tests', () => {
  // Setup and teardown for MongoDB
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    delete process.env.SMTP2GO_API_KEY;
    delete process.env.SMTP2GO_FROM_EMAIL;
    delete process.env.FRONTEND_URL;
  });

  describe('register', () => {
    afterEach(() => {
      delete process.env.REGISTRATION_INVITE_ONLY;
      delete process.env.REGISTRATION_INVITE_CODES;
    });

    it('should register a new user successfully', async () => {
      // Create a mock for bcrypt
      bcrypt.hash.mockResolvedValueOnce('hashedPassword');

      // Mock User.findOne to return null (user doesn't exist)
      User.findOne = jest.fn().mockResolvedValueOnce(null);

      // Mock User.prototype.save to return the user
      const savedUser = {
        _id: 'mockedUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: false,
      };
      const saveMock = jest.fn().mockResolvedValueOnce(savedUser);
      User.prototype.save = saveMock;

      const req = {
        body: {
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      // Verify mocks were called correctly
      expect(User.findOne).toHaveBeenCalledWith({
        $or: [
          { email: 'test@example.com' },
          { username: 'testuser' },
        ],
      });
      expect(saveMock).toHaveBeenCalled();

      // Verify response
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'User registered successfully. Email verification is not required.',
        }),
      );
    });

    // TASK-142: the verification email used to be awaited inline, so signup
    // blocked on SMTP2GO (6211 ms measured live; emailService allows 30s).
    // This test is the mutation proof for the fix: it hands the handler a send
    // that never settles, so `await authController.register(...)` can only
    // return if the handler does NOT wait for it. Restoring the inline await
    // makes this test time out rather than fail an assertion.
    it('responds 201 without waiting for the verification email', async () => {
      process.env.SMTP2GO_API_KEY = 'smtp-key';
      process.env.SMTP2GO_FROM_EMAIL = 'mail@example.com';
      process.env.FRONTEND_URL = 'https://commonly.me';

      bcrypt.hash.mockResolvedValueOnce('hashedPassword');
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      const savedUser = {
        _id: 'mockedUserId',
        username: 'slowmail',
        email: 'slow@example.com',
        password: 'hashedPassword',
        verified: false,
      };
      User.prototype.save = jest.fn().mockResolvedValueOnce(savedUser);

      let releaseSend;
      sendEmail.mockImplementationOnce(() => new Promise((resolve) => {
        releaseSend = resolve;
      }));

      const req = {
        body: {
          username: 'slowmail',
          email: 'slow@example.com',
          password: 'Password123!',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      // The send is still pending at this line; a handler that awaits it never
      // gets here.
      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'slow@example.com' }));

      releaseSend({ data: { succeeded: 1 } });
    });

    // The response must also survive a provider failure, and the failure must
    // be visible in the logs rather than swallowed: after the inline await was
    // removed there is no 502 left to tell an operator the mail never went out.
    it('retries once and logs when the background verification email fails', async () => {
      process.env.SMTP2GO_API_KEY = 'smtp-key';
      process.env.SMTP2GO_FROM_EMAIL = 'mail@example.com';
      process.env.FRONTEND_URL = 'https://commonly.me';

      bcrypt.hash.mockResolvedValueOnce('hashedPassword');
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      const savedUser = {
        _id: 'mockedUserId',
        username: 'failmail',
        email: 'fail@example.com',
        password: 'hashedPassword',
        verified: false,
      };
      User.prototype.save = jest.fn().mockResolvedValueOnce(savedUser);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      sendEmail.mockRejectedValue(new Error('smtp2go unavailable'));

      const req = {
        body: {
          username: 'failmail',
          email: 'fail@example.com',
          password: 'Password123!',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      // Two macrotask turns let both attempts (and the retry) settle.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('verification email failed for user'),
        expect.anything(),
      );

      errorSpy.mockRestore();
    });

    it('names joining the Community pod as the only gate when a mail was sent', async () => {
      // The verification-required branch, which the suite otherwise never reaches
      // (it clears SMTP2GO above). Pinned because the frontend picks its success
      // screen from this sentence: V2Register.test.tsx matches /verify your email/i.
      process.env.SMTP2GO_API_KEY = 'smtp-key';
      process.env.SMTP2GO_FROM_EMAIL = 'mail@example.com';
      process.env.FRONTEND_URL = 'https://commonly.example';
      bcrypt.hash.mockResolvedValueOnce('hashedPassword');
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      User.prototype.save = jest.fn().mockResolvedValueOnce({
        _id: 'mockedUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: false,
      });
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.register({
        body: { username: 'testuser', email: 'test@example.com', password: 'Password123!' },
      }, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Registered. Verify your email to join the Community pod.',
      });
    });

    // TASK-149: the workspace onboarding tail (PG mirror → starter checklist →
    // Guide install + welcome) used to be awaited inline before the 201, and it
    // was ~1.0 s of a 1.59-1.76 s p50 signup. Mutation proof for the split: the
    // checklist is handed a promise that never settles, so `await register(...)`
    // can only return if the handler does not wait for the tail. Restoring the
    // inline await makes this test time out rather than fail an assertion.
    it('responds 201 without waiting for the workspace onboarding tail', async () => {
      const oldPgHost = process.env.PG_HOST;
      delete process.env.PG_HOST;

      // A real ObjectId for the saved row. Note register passes the _id mongoose
      // assigned to the document, not this mock's return value, so the pod
      // create succeeds either way — asserted below rather than assumed here.
      const realUserId = new mongoose.Types.ObjectId();
      bcrypt.hash.mockResolvedValueOnce('hashedPassword');
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      User.prototype.save = jest.fn().mockResolvedValueOnce({
        _id: realUserId,
        username: 'slowtail',
        email: 'slowtail@example.com',
        password: 'hashedPassword',
        verified: false,
      });

      Task.create.mockImplementationOnce(() => new Promise(() => {}));
      let podVisibleAtResponse = null;

      // The store check below races the queued tail — the pod create can land
      // while the count query is in flight — so the order is also pinned
      // synchronously: register has to have RESUMED from the pod create before
      // it writes the response, which is what dropping the await breaks.
      let podCreateResolved = false;
      let podResolvedAtResponse = null;
      const createPod = Pod.create.bind(Pod);
      const createSpy = jest.spyOn(Pod, 'create').mockImplementation((...args) => createPod(...args)
        .then((doc) => {
          podCreateResolved = true;
          return doc;
        }));

      const req = {
        body: {
          username: 'slowtail',
          email: 'slowtail@example.com',
          password: 'Password123!',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        // The pod row has to exist BY the 201 — TASK-144's landing guard reads
        // GET /api/pods immediately after register — so the check runs inside
        // the response mock rather than after it. Moving the pod create into
        // the tail leaves this false, which is the assertion below. Matched by
        // name rather than by createdBy because register uses the _id mongoose
        // assigned at construction, not the one this test's save mock returns.
        json: jest.fn(() => {
          podResolvedAtResponse = podCreateResolved;
          podVisibleAtResponse = Pod.countDocuments({ name: 'My Workspace' })
            .then((count) => count > 0);
        }),
      };

      // The tail is still pending at this line; a handler that awaits it never
      // gets here.
      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      // And the assertion is non-vacuous: the tail ran PAST the pod row as far
      // as the checklist before parking, which is what the never-settling
      // promise is holding. It stays parked for the rest of the test on
      // purpose — releasing it would drag the Guide's install (and a real
      // message post) into a unit suite whose subject is the response path.
      expect(Task.create).toHaveBeenCalledWith([
        expect.objectContaining({ sourceRef: 'onboarding:connect-agent' }),
        expect.objectContaining({ sourceRef: 'onboarding:first-task' }),
        expect.objectContaining({ sourceRef: 'onboarding:invite-teammate' }),
      ]);
      expect(await podVisibleAtResponse).toBe(true);
      expect(podResolvedAtResponse).toBe(true);
      createSpy.mockRestore();

      if (oldPgHost === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = oldPgHost;
    });

    it('should not register a user with an existing email', async () => {
      // Mock User.findOne to return an existing user
      const existingUser = {
        _id: 'existingUserId',
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'hashedPassword',
      };

      // Mock findOne to return the existing user
      User.findOne = jest.fn().mockResolvedValueOnce(existingUser);

      const req = {
        body: {
          username: 'newuser',
          email: 'existing@example.com', // Same email as existing user
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User already exists'),
        }),
      );
    });

    it('should not register a user with an existing username', async () => {
      const existingUser = {
        _id: 'existingUserId',
        username: 'existinguser',
        email: 'existing@example.com',
        password: 'hashedPassword',
      };

      User.findOne = jest.fn().mockResolvedValueOnce(existingUser);

      const req = {
        body: {
          username: 'existinguser',
          email: 'new@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Username already exists'),
        }),
      );
    });

    it('should block registration when invite-only mode is enabled and code is missing', async () => {
      process.env.REGISTRATION_INVITE_ONLY = '1';
      process.env.REGISTRATION_INVITE_CODES = 'alpha-123';

      const req = {
        body: {
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'INVITATION_REQUIRED',
        }),
      );
    });

    it('should register when invite-only mode is enabled and code is valid', async () => {
      process.env.REGISTRATION_INVITE_ONLY = '1';
      process.env.REGISTRATION_INVITE_CODES = 'alpha-123,beta-456';

      bcrypt.hash.mockResolvedValueOnce('hashedPassword');
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      const saveMock = jest.fn().mockResolvedValueOnce({
        _id: 'mockedUserId',
        username: 'testuser',
        email: 'test@example.com',
      });
      User.prototype.save = saveMock;

      const req = {
        body: {
          username: 'testuser',
          email: 'test@example.com',
          password: 'Password123!',
          invitationCode: 'beta-456',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.register(req, res);

      expect(saveMock).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });
    it('refuses a registration that takes an agent type name (TASK-133 b)', async () => {
      const req = {
        body: { username: 'claude-code', email: 'person@example.com', password: 'Password123!' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.register(req, res);

      // Refused before the row exists, which is the only moment the namespace
      // can be defended: an install's alternative is failing closed much later.
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'agent_username_reserved',
      }));
      expect(await User.countDocuments({ username: 'claude-code' })).toBe(0);
    });

    it('refuses the derived agent address (TASK-133 b)', async () => {
      const req = {
        body: {
          username: 'person',
          email: 'person@agents.commonly.local',
          password: 'Password123!',
        },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.register(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'agent_email_reserved',
      }));
      expect(await User.countDocuments({ email: 'person@agents.commonly.local' })).toBe(0);
    });

    it('refuses a name an AgentRegistry row claims (TASK-133 b)', async () => {
      await AgentRegistry.create({
        agentName: 'pixel-helper',
        displayName: 'Pixel Helper',
        description: 'a pod helper',
        manifest: { name: 'pixel-helper', version: '1.0.0' },
      });

      const req = {
        body: { username: 'Pixel-Helper', email: 'person@example.com', password: 'Password123!' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.register(req, res);

      // Case-insensitive, because the User index is (strength-2 collation) and
      // registration stores the username verbatim.
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'agent_username_reserved',
      }));
      expect(await User.countDocuments({ username: 'Pixel-Helper' })).toBe(0);
    });

  });

  describe('login', () => {
    it('should login a verified user successfully', async () => {
      // Mock a verified user
      const user = {
        _id: 'testUserId',
        id: 'testUserId', // Some implementations use id instead of _id
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: true,
        profilePicture: 'default',
      };

      // Mock User.findOne to return the verified user
      User.findOne = jest.fn().mockResolvedValueOnce(user);

      // Mock bcrypt.compare to return true
      bcrypt.compare.mockResolvedValueOnce(true);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      // Mock the JWT signing to return a consistent token for testing
      const mockToken = 'test-jwt-token';
      jest.spyOn(jwt, 'sign').mockImplementation(() => mockToken);

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          token: mockToken,
          verified: true,
          user: expect.objectContaining({
            id: expect.any(String),
            username: 'testuser',
            email: 'test@example.com',
            profilePicture: expect.any(String),
            verified: true,
          }),
        }),
      );
    });

    it('starts a session for an unverified user and marks it in the response', async () => {
      // Mock an unverified user
      const user = {
        _id: 'testUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: false,
      };

      // Mock User.findOne to return the unverified user
      User.findOne = jest.fn().mockResolvedValueOnce(user);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'test-jwt-token',
          verified: false,
          user: expect.objectContaining({
            email: 'test@example.com',
            verified: false,
          }),
        }),
      );
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should not login with incorrect password', async () => {
      // Mock a verified user
      const user = {
        _id: 'testUserId',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedPassword',
        verified: true,
      };

      // Mock User.findOne to return the user
      User.findOne = jest.fn().mockResolvedValueOnce(user);

      // Mock bcrypt.compare to return false for this test only
      bcrypt.compare.mockResolvedValueOnce(false);

      const req = {
        body: {
          email: 'test@example.com',
          password: 'WrongPassword123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.login(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Invalid credentials'),
        }),
      );
    });

    it('does not start a password session for an agent row (TASK-133)', async () => {
      // A bot row is a User and can carry a password hash, so this route used to
      // mint a 7-day session for it. The fix is the predicate, which is what this
      // witness pins: a mock that ignores its query would pass either way, and
      // the refusal it produces is checked at the three verifiers
      // (middleware/auth, middleware/socketAuth, routes/uploads).
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      bcrypt.compare.mockResolvedValueOnce(true);

      const req = { body: { email: 'commonly-bot@example.com', password: 'Password123!' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.login(req, res);

      expect(User.findOne).toHaveBeenCalledWith({
        email: 'commonly-bot@example.com',
        isBot: { $ne: true },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
    });

    it('should not login a non-existent user', async () => {
      const req = {
        body: {
          email: 'nonexistent@example.com',
          password: 'Password123!',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User not found'),
        }),
      );
    });
  });

  describe('resendVerification', () => {
    it('sends a fresh verification link for an unverified human account', async () => {
      process.env.SMTP2GO_API_KEY = 'smtp-key';
      process.env.SMTP2GO_FROM_EMAIL = 'mail@example.com';
      process.env.FRONTEND_URL = 'https://commonly.example';
      const user = {
        _id: 'unverified-user',
        email: 'person@example.com',
        verified: false,
      };
      User.findOne = jest.fn().mockResolvedValueOnce(user);
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.resendVerification({ body: { email: 'Person@Example.com' } }, res);

      expect(User.findOne).toHaveBeenCalledWith({
        email: 'person@example.com',
        isBot: { $ne: true },
      });
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'person@example.com',
        subject: 'Verify Your Email - Commonly',
        textBody: expect.stringContaining('https://commonly.example/verify-email?token=test-jwt-token'),
      }));
      expect(res.json).toHaveBeenCalledWith({
        message: 'If that email has an unverified account, a verification link is on its way.',
      });
    });

    it('answers generically without sending for a verified or unknown address', async () => {
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.resendVerification({ body: { email: 'nobody@example.com' } }, res);

      expect(sendEmail).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        message: 'If that email has an unverified account, a verification link is on its way.',
      });
    });
  });

  describe('verifyEmail', () => {
    it('should verify a user email with valid token', async () => {
      // Create an unverified user object (not saved to DB)
      const userId = new mongoose.Types.ObjectId().toString();
      const updatedUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        verified: true,
      };

      // Mock jwt.verify to return our user ID
      jwt.verify.mockReturnValueOnce({ id: userId });

      // Mock findByIdAndUpdate to return the updated user
      User.findByIdAndUpdate = jest.fn().mockResolvedValueOnce(updatedUser);

      const req = {
        query: {
          token: 'valid-token',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.verifyEmail(req, res);

      expect(ensureUserInCommunityPod).toHaveBeenCalledWith(userId);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Email verified successfully'),
        }),
      );
    });

    it('still verifies successfully when the background community join rejects', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      jwt.verify.mockReturnValueOnce({ id: userId });
      User.findByIdAndUpdate = jest.fn().mockResolvedValueOnce({ _id: userId, verified: true });
      ensureUserInCommunityPod.mockRejectedValueOnce(new Error('community unavailable'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const req = { query: { token: 'valid-token' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await authController.verifyEmail(req, res);
      await Promise.resolve();

      expect(res.json).toHaveBeenCalledWith({ message: 'Email verified successfully' });
      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(warn).toHaveBeenCalledWith(
        '[community-pod] background join failed after auth transition:',
        'community unavailable',
      );
    });

    it('should not verify with an invalid token', async () => {
      // Mock jwt.verify to throw an error
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const req = {
        query: { token: 'invalid-token' },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.verifyEmail(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Invalid or expired token'),
        }),
      );
    });
  });

  describe('getCurrentUser', () => {
    it('should return the current user', async () => {
      // Create a mock user ID
      const userId = new mongoose.Types.ObjectId().toString();

      // Create a mock user with select method
      const mockUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        verified: true,
        profilePicture: 'default',
      };

      // Mock User.findById().select() chain
      const mockSelect = jest.fn().mockResolvedValueOnce(mockUser);
      User.findById = jest.fn().mockReturnValue({
        select: mockSelect,
      });

      const req = {
        userId,
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.getCurrentUser(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'testuser',
          email: 'test@example.com',
        }),
      );
      // Password should not be included
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({
          password: expect.anything(),
        }),
      );
    });

    it('should return 404 if user not found', async () => {
      // Create a mock user ID
      const userId = new mongoose.Types.ObjectId().toString();

      // Mock User.findById().select() to return null
      const mockSelect = jest.fn().mockResolvedValueOnce(null);
      User.findById = jest.fn().mockReturnValue({
        select: mockSelect,
      });

      const req = {
        userId,
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.getCurrentUser(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User not found'),
        }),
      );
    });
  });

  describe('updateProfile', () => {
    it('should update user profile picture', async () => {
      // Create a mock user ID and user objects
      const userId = new mongoose.Types.ObjectId().toString();

      // Initial user returned by findById
      const initialUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        profilePicture: 'default',
        save: jest.fn().mockResolvedValueOnce(true),
      };

      // Updated user returned by findById().select()
      const updatedUser = {
        _id: userId,
        username: 'testuser',
        email: 'test@example.com',
        profilePicture: '/api/uploads/new-profile-pic.png',
      };

      // First mock for the initial findById
      User.findById = jest.fn().mockResolvedValueOnce(initialUser);

      // Second mock for the findById().select() after update
      const mockSelect = jest.fn().mockResolvedValueOnce(updatedUser);
      User.findById.mockReturnValueOnce({
        select: mockSelect,
      });

      const req = {
        userId,
        body: {
          profilePicture: 'https://api.commonly.me/api/uploads/new-profile-pic.png',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.updateProfile(req, res);

      // Verify response
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          profilePicture: '/api/uploads/new-profile-pic.png',
        }),
      );

      // Verify save was called
      expect(initialUser.save).toHaveBeenCalled();
      expect(initialUser.profilePicture).toBe('/api/uploads/new-profile-pic.png');
    });

    it('should return 404 if user not found', async () => {
      // Create a mock user ID
      const userId = new mongoose.Types.ObjectId().toString();

      // Mock findById to return null (user not found)
      User.findById = jest.fn().mockResolvedValueOnce(null);

      const req = {
        userId,
        body: {
          profilePicture: 'new-profile-pic-url',
        },
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.updateProfile(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('User not found'),
        }),
      );
    });
  });

  describe('requestWaitlist', () => {
    it('submits a new waitlist request', async () => {
      User.findOne = jest.fn().mockResolvedValueOnce(null);
      WaitlistRequest.findOne = jest.fn().mockResolvedValueOnce(null);
      WaitlistRequest.create = jest.fn().mockResolvedValueOnce({ _id: 'w1' });

      const req = {
        body: {
          email: 'new@example.com',
          name: 'New User',
          note: 'Need access for community pod',
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.requestWaitlist(req, res);

      expect(WaitlistRequest.create).toHaveBeenCalledWith(expect.objectContaining({
        email: 'new@example.com',
        status: 'pending',
      }));
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns conflict when email is already registered', async () => {
      User.findOne = jest.fn().mockResolvedValueOnce({ _id: 'u1', email: 'new@example.com' });

      const req = { body: { email: 'new@example.com' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await authController.requestWaitlist(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'ALREADY_REGISTERED',
      }));
    });
  });
});
