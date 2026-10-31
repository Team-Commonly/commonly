// TASK-715: the instance sign-in allowlist is re-checked on every session
// verifier, not only at register/login. A session minted before the list
// existed (or for an address since removed) is refused on its next request
// without rotating JWT_SECRET. Unrestricted instances behave as before.
const jwt = require('jsonwebtoken');

jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn(() => Promise.resolve()),
}));

const User = require('../../../models/User');
const authMiddleware = require('../../../middleware/auth');
const { socketAuthMiddleware } = require('../../../middleware/socketAuth');
const { sessionRefusal } = require('../../../services/sessionAccountService');

const secret = 'allowlist-secret';
const row = (value) => ({ select: () => ({ lean: async () => value }) });
// The cm_ reads must project the fields the term reads; a mock that ignores
// `select` would hide a dropped `email` or `verified`.
const selectable = (value) => ({
  select: async (fields) => {
    expect(fields).toEqual(expect.stringMatching(/\bemail\b/));
    expect(fields).toEqual(expect.stringMatching(/\bverified\b/));
    expect(fields).toEqual(expect.stringMatching(/\bisBot\b/));
    return value;
  },
});

const reqWith = (token) => ({
  method: 'GET',
  baseUrl: '/api/pods',
  path: '/',
  header: jest.fn((name) => (name === 'Authorization' ? `Bearer ${token}` : null)),
});
const resMock = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

const runAuth = async (token) => {
  const req = reqWith(token);
  const res = resMock();
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return { req, res, next };
};

describe('instance allowlist on session verifiers', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.AUTH_ALLOWED_DOMAINS;
    User.findById.mockReset();
    User.findOne.mockReset();
  });

  afterAll(() => {
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.AUTH_ALLOWED_DOMAINS;
  });

  describe('sessionRefusal truth table', () => {
    const human = (email, verified = true) => ({
      banned: false, isBot: false, email, verified, 
    });

    it('is unchanged when no list is set, whatever the email', () => {
      expect(sessionRefusal(human('anyone@elsewhere.com'))).toBeNull();
      expect(sessionRefusal(human(undefined))).toBeNull();
    });

    it('refuses an address that is not on the list', () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      expect(sessionRefusal(human('other@elsewhere.com'))).toBe('restricted');
    });

    it('passes an allowed address and an allowed domain, case-insensitively', () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      process.env.AUTH_ALLOWED_DOMAINS = '@Corp.example';
      expect(sessionRefusal(human('OK@team.com'))).toBeNull();
      expect(sessionRefusal(human('dev@corp.example'))).toBeNull();
    });

    it('fails shut on a row with no email once the list is on', () => {
      process.env.AUTH_ALLOWED_DOMAINS = 'corp.example';
      expect(sessionRefusal(human(undefined))).toBe('restricted');
    });

    it('refuses an unverified row on an allowlisted address, mirroring login', () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      expect(sessionRefusal(human('ok@team.com', false))).toBe('restricted');
      expect(sessionRefusal({ banned: false, email: 'ok@team.com' })).toBe('restricted');
    });

    it('ignores verified when the instance is unrestricted', () => {
      expect(sessionRefusal(human('ok@team.com', false))).toBeNull();
    });

    it('keeps ban and bot ahead of the allowlist term', () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      expect(sessionRefusal({ banned: true, email: 'x@y.com' })).toBe('banned');
      expect(sessionRefusal({ isBot: true, email: 'x@y.com' })).toBe('bot');
    });
  });

  describe('Express auth', () => {
    it('refuses a pre-existing JWT for a non-allowlisted email with 403', async () => {
      const token = jwt.sign({ id: 'u1' }, secret);
      User.findById.mockReturnValue(row({ banned: false, email: 'old@elsewhere.com' }));
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';

      const { res, next } = await runAuth(token);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSTANCE_ACCESS_RESTRICTED' }));
    });

    it('still serves an allowlisted JWT', async () => {
      const token = jwt.sign({ id: 'u2' }, secret);
      User.findById.mockReturnValue(row({ banned: false, email: 'ok@team.com', verified: true }));
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';

      const { req, next } = await runAuth(token);

      expect(next).toHaveBeenCalled();
      expect(req.userId).toBe('u2');
    });

    it('refuses a JWT for an allowlisted but unverified account, and a cm_ token too', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      User.findById.mockReturnValue(row({ banned: false, email: 'ok@team.com', verified: false }));
      const jwtRun = await runAuth(jwt.sign({ id: 'u9' }, secret));
      expect(jwtRun.next).not.toHaveBeenCalled();
      expect(jwtRun.res.status).toHaveBeenCalledWith(403);

      User.findOne.mockReturnValueOnce(selectable({
        _id: { toString: () => 'u10' }, username: 'u10', email: 'ok@team.com', verified: false, role: 'user',
      }));
      const cmRun = await runAuth('cm_unverified');
      expect(cmRun.next).not.toHaveBeenCalled();
      expect(cmRun.res.status).toHaveBeenCalledWith(403);
    });

    it('keeps an agent cm_ user token working on a restricted instance', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      User.findOne.mockReturnValueOnce(selectable({
        _id: { toString: () => 'bot1' },
        username: 'openclaw-bot',
        email: 'openclaw-bot@agents.commonly.local',
        role: 'user',
        isBot: true,
        verified: false,
      }));

      const { next, res } = await runAuth('cm_agent-user-token');

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('serves the same non-allowlisted JWT when the instance is unrestricted', async () => {
      const token = jwt.sign({ id: 'u3' }, secret);
      User.findById.mockReturnValue(row({ banned: false, email: 'old@elsewhere.com' }));

      const { next } = await runAuth(token);

      expect(next).toHaveBeenCalled();
    });

    it('refuses a cm_ API token owned by a non-allowlisted email', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      User.findOne.mockReturnValueOnce(selectable({
        _id: { toString: () => 'u4' }, username: 'u4', email: 'old@elsewhere.com', role: 'user',
      }));

      const { res, next } = await runAuth('cm_plaintext-api-token');

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSTANCE_ACCESS_RESTRICTED' }));
    });

    it('refuses a cm_ device token owned by a non-allowlisted email', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      User.findOne
        .mockReturnValueOnce(selectable(null))
        .mockReturnValueOnce(selectable({
          _id: { toString: () => 'u5' }, username: 'u5', email: 'old@elsewhere.com', role: 'user',
        }));

      const { res, next } = await runAuth('cm_device-bearer');

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('serves a cm_ API token for an allowlisted email, and any email when unrestricted', async () => {
      const owner = {
        _id: { toString: () => 'u6' }, username: 'u6', email: 'ok@team.com', verified: true, role: 'user', 
      };
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      User.findOne.mockReturnValueOnce(selectable(owner));
      expect((await runAuth('cm_ok')).next).toHaveBeenCalled();

      delete process.env.AUTH_ALLOWED_EMAILS;
      User.findOne.mockReturnValueOnce(selectable({ ...owner, email: 'old@elsewhere.com' }));
      expect((await runAuth('cm_any')).next).toHaveBeenCalled();
    });
  });

  describe('Socket.io handshake', () => {
    const handshake = async (token, account) => {
      User.findById.mockReturnValue(row(account));
      const socket = { handshake: { auth: { token } } };
      const next = jest.fn();
      await socketAuthMiddleware(socket, next);
      return { socket, next };
    };

    it('refuses a non-allowlisted session and accepts an allowlisted one', async () => {
      process.env.AUTH_ALLOWED_EMAILS = 'ok@team.com';
      const token = jwt.sign({ id: 'u7' }, secret);

      const refused = await handshake(token, { banned: false, email: 'old@elsewhere.com' });
      expect(refused.socket.userId).toBeUndefined();
      expect(refused.next).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Authentication error: Invalid token',
      }));

      const accepted = await handshake(token, { banned: false, email: 'ok@team.com', verified: true });
      expect(accepted.socket.userId).toBe('u7');
      expect(accepted.next).toHaveBeenCalledWith();
    });

    it('is unchanged when the instance is unrestricted', async () => {
      const token = jwt.sign({ id: 'u8' }, secret);
      const { socket } = await handshake(token, { banned: false, email: 'old@elsewhere.com' });
      expect(socket.userId).toBe('u8');
    });
  });
});
