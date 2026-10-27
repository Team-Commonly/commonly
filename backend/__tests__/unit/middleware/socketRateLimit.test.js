const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const { installSocketEventBudget } = require('../../../middleware/socketRateLimit');

// The budget is per-packet socket middleware, so these run a real Socket.IO
// server and client: what counts is which packets reach a handler. Budgets
// are per user and live for the module, so every case uses fresh user ids.
describe('socket event budget', () => {
  let httpServer;
  let io;
  let url;
  let clients;
  let handled;

  const newUserId = () => String(new mongoose.Types.ObjectId());
  const podId = String(new mongoose.Types.ObjectId());

  const connect = (userId) => new Promise((resolve, reject) => {
    const client = connectClient(url, { auth: { userId }, forceNew: true });
    clients.push(client);
    client.limited = [];
    client.errors = [];
    client.on('rateLimited', (payload) => client.limited.push(payload));
    client.on('error', (payload) => client.errors.push(payload));
    client.once('ready', () => resolve(client));
    client.once('connect_error', reject);
  });
  // Packets on one connection are handled in order, so once the fence's ack
  // arrives every packet sent before it has been admitted or dropped.
  const fence = (client) => new Promise((resolve) => { client.emit('fence', resolve); });
  const count = (userId, event) => handled.filter((h) => h.userId === userId && h.event === event).length;

  beforeAll(async () => {
    httpServer = http.createServer();
    io = new Server(httpServer);
    io.on('connection', (socket) => {
      socket.userId = socket.handshake.auth.userId;
      installSocketEventBudget(socket);
      ['sendMessage', 'joinPod', 'leavePod', 'other'].forEach((event) => {
        socket.on(event, () => handled.push({ userId: socket.userId, event }));
      });
      socket.on('fence', (ack) => ack());
      socket.emit('ready');
    });
    await new Promise((resolve) => { httpServer.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${httpServer.address().port}`;
  });

  beforeEach(() => {
    clients = [];
    handled = [];
  });

  afterEach(() => {
    clients.forEach((client) => client.disconnect());
  });

  afterAll(() => {
    io.close();
  });

  it('admits 60 sendMessage packets a minute, then answers rateLimited instead of error', async () => {
    const userId = newUserId();
    const client = await connect(userId);

    for (let i = 0; i < 61; i += 1) client.emit('sendMessage', { podId, content: `m${i}` });
    await fence(client);

    expect(count(userId, 'sendMessage')).toBe(60);
    expect(client.limited).toHaveLength(1);
    expect(client.limited[0].event).toBe('sendMessage');
    expect(client.limited[0].retryAfterMs).toBeGreaterThan(0);
    expect(client.limited[0].retryAfterMs).toBeLessThanOrEqual(60000);
    expect(client.errors).toEqual([]);
  });

  it('refills the budget when the minute is up', async () => {
    const userId = newUserId();
    const client = await connect(userId);
    for (let i = 0; i < 61; i += 1) client.emit('sendMessage', { podId, content: 'a' });
    await fence(client);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 60001);
    try {
      client.emit('sendMessage', { podId, content: 'later' });
      await fence(client);
    } finally { clock.mockRestore(); }

    expect(count(userId, 'sendMessage')).toBe(61);
    expect(client.limited).toHaveLength(1);
  });

  it('shares one budget across every socket of a user, and none with another user', async () => {
    const userId = newUserId();
    const otherId = newUserId();
    const [tab1, tab2] = [await connect(userId), await connect(userId)];
    const other = await connect(otherId);

    for (let i = 0; i < 30; i += 1) tab1.emit('sendMessage', { podId, content: 'a' });
    await fence(tab1);
    for (let i = 0; i < 31; i += 1) tab2.emit('sendMessage', { podId, content: 'b' });
    await fence(tab2);
    other.emit('sendMessage', { podId, content: 'c' });
    await fence(other);

    expect(count(userId, 'sendMessage')).toBe(60);
    expect(tab2.limited).toHaveLength(1);
    expect(count(otherId, 'sendMessage')).toBe(1);
  });

  it('counts joinPod and leavePod against one 120-a-minute room budget', async () => {
    const userId = newUserId();
    const client = await connect(userId);

    for (let i = 0; i < 60; i += 1) client.emit('joinPod', podId);
    for (let i = 0; i < 61; i += 1) client.emit('leavePod', podId);
    await fence(client);

    expect(count(userId, 'joinPod') + count(userId, 'leavePod')).toBe(120);
    expect(client.limited.map((l) => l.event)).toEqual(['leavePod']);
  });

  it('drops a pod event whose pod id is not an ObjectId string before any handler', async () => {
    const userId = newUserId();
    const client = await connect(userId);

    client.emit('joinPod', { $gt: '' });
    client.emit('joinPod', 'not-an-id');
    client.emit('leavePod', 42);
    client.emit('sendMessage', { podId: { $ne: null }, content: 'x' });
    client.emit('sendMessage', { podId: [podId], content: 'x' });
    await fence(client);

    expect(handled.filter((h) => h.userId === userId)).toEqual([]);
    expect(client.limited).toEqual([]);
  });

  // server.ts builds its socket handlers inline, so the wiring is guarded by
  // presence: installed on every connection, ahead of the session re-check.
  it('is installed on every server connection before the session guard', () => {
    // eslint-disable-next-line global-require
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../../server.ts'), 'utf8');
    const handler = source.slice(source.indexOf("io.on('connection'"));
    const budgetAt = handler.indexOf('installSocketEventBudget(socket);');

    expect(budgetAt).toBeGreaterThan(-1);
    expect(budgetAt).toBeLessThan(handler.indexOf('installSocketSessionGuard(socket);'));
  });

  it('caps all events together at 600 a minute', async () => {
    const userId = newUserId();
    const client = await connect(userId);

    for (let i = 0; i < 599; i += 1) client.emit('other');
    await fence(client);
    client.emit('other');
    client.emit('other');
    await new Promise((resolve) => { client.once('rateLimited', resolve); });

    // 599 + the fence fill the budget; neither later packet gets through.
    expect(count(userId, 'other')).toBe(599);
  });

  it('counts malformed pod events against the 600 ceiling, and stops logging them past it', async () => {
    const userId = newUserId();
    const client = await connect(userId);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 599; i += 1) client.emit('joinPod', { $gt: '' });
      await fence(client);
      client.emit('joinPod', { $gt: '' });
      await new Promise((resolve) => { client.once('rateLimited', resolve); });

      // 599 malformed + the fence fill the ceiling, so the next one is refused
      // as over budget, not logged again.
      expect(warn).toHaveBeenCalledTimes(599);
      expect(client.limited.map((l) => l.event)).toEqual(['joinPod']);
      expect(count(userId, 'joinPod')).toBe(0);
    } finally { warn.mockRestore(); }
  });
});
