// TASK-290 A: the register page asks only for an email and a password, so a
// signup with no username gets one derived from the email. A client that sends
// a username keeps it. Real models on the in-memory Mongo, so "taken" and
// "reserved" are answered by the same rows and indexes production uses.
const User = require('../../../models/User');
const { AgentRegistry } = require('../../../models/AgentRegistry');

jest.mock('../../../services/communityPodService', () => ({
  ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ data: { succeeded: 1 } }),
}));
jest.mock('../../../models/Task', () => ({ create: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../services/pgPodSyncService', () => ({
  syncPodFromMongo: jest.fn().mockResolvedValue({}),
}));

const authController = require('../../../controllers/authController');
const { usernameBaseFromEmail } = require('../../../services/derivedUsername');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

// What every @-mention reader accepts: agentMentionService needs 2+ of
// [a-z0-9_-], agentMessageService [a-z0-9][a-z0-9-]{0,39}, the v2 renderer
// [a-zA-Z0-9][a-zA-Z0-9_-]*. A derived handle has to sit inside all three.
const MENTION_SAFE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const register = async (body) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await authController.register({ body: { password: 'Password123!', ...body } }, res);
  return res;
};

const usernameOf = async (email) => (await User.findOne({ email }).lean())?.username;

describe('register with no username (TASK-290 A)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    // The unique username index has to exist for the race below to collide.
    // Not User.init(): the model's collation index on the same key clashes
    // with it by name and rejects.
    await User.collection.createIndex({ username: 1 }, { unique: true });
  });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
  });

  it('derives the handle from the email local part, plus-tag dropped', async () => {
    const res = await register({ email: 'Sam.Lee+news@Example.com' });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(await usernameOf('sam.lee+news@example.com')).toBe('sam-lee');
  });

  it('keeps a username the client sends, exactly as before', async () => {
    const res = await register({ username: 'Typed_Name', email: 'sam.lee@example.com' });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(await usernameOf('sam.lee@example.com')).toBe('Typed_Name');
  });

  it('adds a short suffix when another account holds the name in any case', async () => {
    await User.create({ username: 'Sam-Lee', email: 'first@example.com', password: 'x-password' });

    const res = await register({ email: 'sam.lee@example.com' });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(await usernameOf('sam.lee@example.com')).toMatch(/^sam-lee-[0-9a-f]{4}$/);
  });

  it('never derives a name reserved for an agent install (TASK-133 b)', async () => {
    await AgentRegistry.create({
      agentName: 'pixel-helper',
      displayName: 'Pixel Helper',
      description: 'a pod helper',
      manifest: { name: 'pixel-helper', version: '1.0.0' },
    });

    const typeName = await register({ email: 'claude-code@example.com' });
    const claimed = await register({ email: 'pixel.helper@example.com' });

    expect(typeName.status).toHaveBeenCalledWith(201);
    expect(claimed.status).toHaveBeenCalledWith(201);
    expect(await usernameOf('claude-code@example.com')).toMatch(/^claude-code-[0-9a-f]{4}$/);
    expect(await usernameOf('pixel.helper@example.com')).toMatch(/^pixel-helper-[0-9a-f]{4}$/);
  });

  it.each([
    ['one character', 'a@example.com', /^a-[0-9a-f]{4}$/],
    ['no letters or digits it can keep', '李雷@example.com', /^user-[0-9a-f]{4}$/],
  ])('suffixes a local part with %s', async (_label, email, expected) => {
    const res = await register({ email });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(await usernameOf(email)).toMatch(expected);
  });

  it('derives a handle every mention reader accepts', () => {
    const cases = [
      'sam.lee', 'sam_lee', '-dash-', 'a..b__c', 'UPPER.Case', '1st', 'x'.repeat(60),
      `${'ab.'.repeat(14)}z`, // a separator lands on the cut
    ];
    cases.forEach((local) => {
      const base = usernameBaseFromEmail(`${local}@example.com`);
      expect(base.length).toBeLessThanOrEqual(30);
      // No hyphen at either end or doubled, so the suffix reads "sam-lee-1a2b".
      expect(base).not.toMatch(/^-|-$|--/);
      expect(`${base}-ffff`).toMatch(MENTION_SAFE);
      if (base.length >= 2) expect(base).toMatch(MENTION_SAFE);
    });
  });

  it('derives again when another signup takes the name between the check and the save', async () => {
    const originalSave = User.prototype.save;
    let raced = false;
    jest.spyOn(User.prototype, 'save').mockImplementation(async function save(...args) {
      if (!raced && this.username === 'racer') {
        raced = true;
        await User.create({ username: 'racer', email: 'other@example.com', password: 'x-password' });
      }
      return originalSave.apply(this, args);
    });

    const res = await register({ email: 'racer@example.com' });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(await usernameOf('racer@example.com')).toMatch(/^racer-[0-9a-f]{4}$/);
  });

  it('still answers an address that is already registered', async () => {
    await User.create({ username: 'someone', email: 'taken@example.com', password: 'x-password' });

    const res = await register({ email: 'taken@example.com' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'User already exists' });
  });

  it('requires only an email and a password', async () => {
    const res = await register({ email: '', password: '' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Email and password are required.' });
  });
});
