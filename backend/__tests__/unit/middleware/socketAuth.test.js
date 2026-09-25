// TASK-133 (d): the Socket.io handshake reads the live row.
//
// It previously verified the signature and stopped: a session whose account had
// since been banned, deleted, or converted into an agent could still subscribe to
// pod rooms and `sendMessage`. The middleware is called directly here — that is
// exactly what `io.use(...)` does — so the whole check runs without a socket
// server.
const jwt = require('jsonwebtoken');

jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

const User = require('../../../models/User');
const { socketAuthMiddleware } = require('../../../middleware/socketAuth');

const row = (value) => ({ select: () => ({ lean: async () => value }) });
const socketWith = (token) => ({ handshake: { auth: token === undefined ? {} : { token } } });

describe('socketAuthMiddleware', () => {
  const secret = 'socket-secret';

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    User.findById.mockReset();
  });

  const run = async (token, account) => {
    User.findById.mockReturnValue(row(account));
    const socket = socketWith(token);
    const next = jest.fn();
    await socketAuthMiddleware(socket, next);
    return { socket, next };
  };

  it('accepts a human session and hands the socket its user id', async () => {
    const token = jwt.sign({ id: 'human-1' }, secret);

    const { socket, next } = await run(token, { banned: false, isBot: false });

    expect(socket.userId).toBe('human-1');
    expect(next).toHaveBeenCalledWith();
  });

  it('refuses an agent session instead of letting it open a user socket', async () => {
    const token = jwt.sign({ id: 'bot-1' }, secret);

    const { socket, next } = await run(token, { banned: false, isBot: true });

    expect(socket.userId).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication error: Agent accounts authenticate with their runtime token',
    }));
  });

  it('refuses a banned session — the HTTP surface enforced this and the socket did not', async () => {
    const token = jwt.sign({ id: 'human-2' }, secret);

    const { socket, next } = await run(token, { banned: true, isBot: false });

    expect(socket.userId).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication error: Invalid token',
    }));
  });

  it('refuses a session whose row is gone', async () => {
    const token = jwt.sign({ id: 'human-3' }, secret);

    const { socket, next } = await run(token, null);

    expect(socket.userId).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication error: Invalid token',
    }));
  });

  it('refuses a session that has become an agent between two handshakes', async () => {
    // The token was minted while the row was human; the conversion happened
    // after. This is the whole reason the check reads the row rather than
    // trusting the signature.
    const token = jwt.sign({ id: 'human-4' }, secret);
    User.findById.mockReturnValueOnce(row({ banned: false, isBot: false }));
    const first = socketWith(token);
    const firstNext = jest.fn();
    await socketAuthMiddleware(first, firstNext);
    expect(first.userId).toBe('human-4');

    const second = await run(token, { banned: false, isBot: true });

    expect(second.socket.userId).toBeUndefined();
    expect(second.next).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication error: Agent accounts authenticate with their runtime token',
    }));
  });

  it('refuses a handshake with no token, and a signature it cannot verify', async () => {
    const missing = await socketAuthMiddleware(socketWith(undefined), jest.fn());
    expect(missing).toBeUndefined();

    const noToken = jest.fn();
    await socketAuthMiddleware(socketWith(undefined), noToken);
    expect(noToken).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication error: Token not provided',
    }));

    const forged = jest.fn();
    await socketAuthMiddleware(socketWith(jwt.sign({ id: 'human-5' }, 'other-secret')), forged);
    expect(forged).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication error: Invalid token',
    }));
  });

  it('accepts the { user: { id } } token shape the CLI mints', async () => {
    const token = jwt.sign({ user: { id: 'human-6' } }, secret);

    const { socket, next } = await run(token, { banned: false, isBot: false });

    expect(socket.userId).toBe('human-6');
    expect(next).toHaveBeenCalledWith();
  });
});
