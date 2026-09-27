// The rotation script writes credentials to production rows, so its arms are
// about the write path: the hash that proves the pre-save hook ran, the refusal
// that happens before the first write, and the two faults its read-back has to
// tell apart. Everything here runs against the REAL User model on an in-memory
// Mongo (testUtils), so the bcrypt hook and `comparePassword` are the model's
// own — a mocked save would certify the mock, not the write.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../../../models/User');
const {
  rotateBotPasswords,
  exitCodeFor,
  generateBotPassword,
  main,
} = require('../../../scripts/rotate-bot-passwords');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const OLD_PLAIN = 'agent-password-1758000000000';
const NEW_PLAIN = 'rotated-plain-password-under-test';
const HUMAN_PLAIN = 'human-plain-password';

const BCRYPT_HASH = /^\$2[aby]\$/;

const seedBot = (overrides = {}) => User.create({
  username: 'agent-bot',
  email: 'agent-bot@example.com',
  isBot: true,
  password: OLD_PLAIN,
  ...overrides,
});

// OAuth-created account: no password field at all, which is the state the
// refusal exists for (User.ts:204-212).
const seedProviderBot = (overrides = {}) => User.create({
  username: 'agent-oauth',
  email: 'agent-oauth@example.com',
  isBot: true,
  authProviders: [{ provider: 'google', providerId: 'google-1' }],
  ...overrides,
});

const seedHuman = () => User.create({
  username: 'human',
  email: 'human@example.com',
  isBot: false,
  password: HUMAN_PLAIN,
});

const storedPassword = async (id) => String((await User.findById(id)).password);

describe('rotate-bot-passwords', () => {
  beforeAll(async () => setupMongoDb());
  afterAll(async () => closeMongoDb());
  beforeEach(async () => clearMongoDb());

  afterEach(() => {
    jest.restoreAllMocks();
    // Keep the status from leaking between arms. An arm that reads the status
    // must not be able to see a previous arm's value.
    delete process.exitCode;
  });

  it('a dry run names the bots it would rotate and writes nothing', async () => {
    const botA = await seedBot({ username: 'agent-a', email: 'a@example.com' });
    const botB = await seedBot({ username: 'agent-b', email: 'b@example.com' });
    const human = await seedHuman();
    const before = {
      a: await storedPassword(botA._id),
      b: await storedPassword(botB._id),
      human: await storedPassword(human._id),
    };
    expect(before.a).toMatch(BCRYPT_HASH);

    const r = await rotateBotPasswords({ dryRun: true, generate: () => NEW_PLAIN });

    expect(r).toEqual(expect.objectContaining({
      dryRun: true, examined: 2, rotated: 0, verified: 0, refused: false, unverified: [],
    }));
    expect(r.toRotate).toEqual(['agent-a', 'agent-b']);
    // The discriminating observation for "nothing was written" is the stored
    // hash, not the count: a dry run that wrote would still report rotated: 0.
    expect(await storedPassword(botA._id)).toBe(before.a);
    expect(await storedPassword(botB._id)).toBe(before.b);
    expect(await storedPassword(human._id)).toBe(before.human);
    expect(r.toRotate).not.toContain('human');
  });

  it('rotates each bot through the model, and the old password stops working', async () => {
    const botA = await seedBot({ username: 'agent-a', email: 'a@example.com' });
    const botB = await seedBot({ username: 'agent-b', email: 'b@example.com' });
    const before = { a: await storedPassword(botA._id), b: await storedPassword(botB._id) };
    expect(await (await User.findById(botA._id)).comparePassword(OLD_PLAIN)).toBe(true);

    const r = await rotateBotPasswords({ dryRun: false, generate: () => NEW_PLAIN });

    expect(r).toEqual(expect.objectContaining({
      rotated: 2, verified: 2, unverified: [], refused: false,
    }));

    // A plaintext anywhere in these pairs is the failure the script exists to
    // avoid: `updateMany` would store NEW_PLAIN verbatim and the row count
    // would still be right.
    const assertRotated = async (id, previous) => {
      const stored = await storedPassword(id);
      expect(stored).toMatch(BCRYPT_HASH);
      expect(stored).not.toContain(NEW_PLAIN);
      expect(stored).not.toBe(previous);
      const doc = await User.findById(id);
      expect(await doc.comparePassword(NEW_PLAIN)).toBe(true);
      expect(await doc.comparePassword(OLD_PLAIN)).toBe(false);
    };
    await assertRotated(botA._id, before.a);
    await assertRotated(botB._id, before.b);
    // Distinct salts: one generator for the whole run still yields two hashes.
    expect(await storedPassword(botA._id)).not.toBe(await storedPassword(botB._id));
  });

  it('leaves a non-bot account alone', async () => {
    const bot = await seedBot({ username: 'agent-a', email: 'a@example.com' });
    const human = await seedHuman();
    const humanBefore = await storedPassword(human._id);

    const r = await rotateBotPasswords({ dryRun: false, generate: () => NEW_PLAIN });

    expect(r.examined).toBe(1);
    expect(r.toRotate).toEqual(['agent-a']);
    expect(await storedPassword(human._id)).toBe(humanBefore);
    expect(await (await User.findById(human._id)).comparePassword(HUMAN_PLAIN)).toBe(true);
    expect(await (await User.findById(human._id)).comparePassword(NEW_PLAIN)).toBe(false);
    expect(await (await User.findById(bot._id)).comparePassword(NEW_PLAIN)).toBe(true);
  });

  it('refuses the whole run when a bot has no stored password, writing nothing', async () => {
    const botA = await seedBot({ username: 'agent-a', email: 'a@example.com' });
    const oauthBot = await seedProviderBot();
    const beforeA = await storedPassword(botA._id);

    const r = await rotateBotPasswords({ dryRun: false, generate: () => NEW_PLAIN });

    expect(r.refused).toBe(true);
    expect(r.withoutPassword).toEqual(['agent-oauth']);
    expect(r.toRotate).toEqual(['agent-a']);
    expect(r.rotated).toBe(0);
    expect(exitCodeFor(r)).toBe(2);
    // The classifiable bot is not rotated either: a half-rotated fleet is not a
    // result an operator can check against a pre-state.
    expect(await storedPassword(botA._id)).toBe(beforeA);
    expect(await (await User.findById(botA._id)).comparePassword(OLD_PLAIN)).toBe(true);
    expect((await User.findById(oauthBot._id)).password).toBeUndefined();
  });

  it('a save that resolves without persisting is unverified, and the run stops there', async () => {
    const botA = await seedBot({ username: 'agent-a', email: 'a@example.com' });
    const botB = await seedBot({ username: 'agent-b', email: 'b@example.com' });
    const before = { a: await storedPassword(botA._id), b: await storedPassword(botB._id) };
    // The one state a real connection will not produce on demand: a save that
    // resolves and writes nothing. Its only signature is the stored value being
    // byte-identical to the one the read-back replaced, which is why the script
    // compares rather than trusting `save()`.
    jest.spyOn(User.prototype, 'save').mockResolvedValueOnce(botA);

    const r = await rotateBotPasswords({ dryRun: false, generate: () => NEW_PLAIN });

    expect(r.unverified).toEqual(['agent-a']);
    expect(r.rotated).toBe(0);
    expect(r.verified).toBe(0);
    expect(exitCodeFor(r)).toBe(3);
    expect(await storedPassword(botA._id)).toBe(before.a);
    // Not just "a is unchanged": b must not be rotated after a failed read-back.
    expect(await storedPassword(botB._id)).toBe(before.b);
  });

  it('a save that hashes but does not persist is caught by the read-back, not by the in-memory value', async () => {
    const bot = await seedBot({ username: 'agent-a', email: 'a@example.com' });
    const before = await storedPassword(bot._id);
    // The hook's own two lines (User.ts:419-421) with persistence withheld. A
    // real connection cannot be made to hash-then-fail on demand, and this is
    // the one state that tells a re-read apart from the value the script is
    // already holding: in memory the document carries a valid fresh hash, and
    // the store still carries the old one.
    jest.spyOn(User.prototype, 'save').mockImplementationOnce(async function hashWithoutPersisting() {
      this.password = await bcrypt.hash(String(this.password), 10);
      return this;
    });

    const r = await rotateBotPasswords({ dryRun: false, generate: () => NEW_PLAIN });

    expect(r.unverified).toEqual(['agent-a']);
    expect(r.rotated).toBe(0);
    expect(await storedPassword(bot._id)).toBe(before);
  });

  it('a generated password is not a clock reading', () => {
    const first = generateBotPassword();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(generateBotPassword());
    // The pre-TASK-163 shape: `agent-password-<milliseconds>`.
    expect(first).not.toMatch(/^agent-password-\d+$/);
  });

  describe('exit status', () => {
    const asReport = (overrides) => ({
      dryRun: false,
      examined: 0,
      toRotate: [],
      rotated: 0,
      verified: 0,
      unverified: [],
      withoutPassword: [],
      refused: false,
      examples: { toRotate: null, withoutPassword: null },
      ...overrides,
    });

    it('maps each state to its own code, and refusal wins when both are true', () => {
      expect(exitCodeFor(asReport({}))).toBe(0);
      expect(exitCodeFor(asReport({ refused: true, withoutPassword: ['b'] }))).toBe(2);
      expect(exitCodeFor(asReport({ unverified: ['b'] }))).toBe(3);
      expect(exitCodeFor(asReport({ refused: true, unverified: ['b'] }))).toBe(2);
    });

    it('main() is a dry run without --apply, exits 0, and writes nothing', async () => {
      const bot = await seedBot({ username: 'agent-a', email: 'a@example.com' });
      const before = await storedPassword(bot._id);
      jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);

      await main(['node', 'rotate-bot-passwords.js']);

      expect(process.exitCode).toBe(0);
      expect(await storedPassword(bot._id)).toBe(before);
    });

    it('main() with a refusal exits 2 rather than reporting a clean run', async () => {
      await seedProviderBot();
      jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);

      await main(['node', 'rotate-bot-passwords.js', '--apply']);

      expect(process.exitCode).toBe(2);
    });

    it('main() with an unverified save exits 3', async () => {
      const bot = await seedBot({ username: 'agent-a', email: 'a@example.com' });
      jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
      jest.spyOn(User.prototype, 'save').mockResolvedValueOnce(bot);

      await main(['node', 'rotate-bot-passwords.js', '--apply']);

      expect(process.exitCode).toBe(3);
    });
  });
});
