// MarkSurface against the real User schema. The sibling suite mocks
// User, so it cannot see a field the schema would strip in strict mode.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let User;
let markEmailVerified;
let markSurface;
let resetOnboardingMarksForTest;

const readOnboarding = async (id) => (await User.findById(id).lean()).onboarding || {};
const waitForField = async (id, field) => {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const onboarding = await readOnboarding(id);
    if (onboarding[field]) return onboarding;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`onboarding.${field} was never written`);
};
const settle = () => new Promise((r) => setTimeout(r, 100));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  User = require('../../../models/User');
  ({ markEmailVerified, markSurface, resetOnboardingMarksForTest } = require('../../../services/onboardingMarks'));
});
afterEach(async () => {
  resetOnboardingMarksForTest();
  await User.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const makeUser = (extra = {}) => User.create({
  username: `maya${Math.floor(Math.random() * 1e9)}`,
  email: `maya${Math.floor(Math.random() * 1e9)}@example.test`,
  password: 'not-a-real-password-hash',
  ...extra,
});

describe('markEmailVerified on the real User schema', () => {
  test('writes verifiedAt once and never overwrites it', async () => {
    const user = await makeUser();
    markEmailVerified(user._id);
    const { verifiedAt } = await waitForField(user._id, 'verifiedAt');
    markEmailVerified(user._id);
    await settle();
    expect((await readOnboarding(user._id)).verifiedAt.getTime()).toBe(verifiedAt.getTime());
  });

  test('never marks a bot', async () => {
    const bot = await makeUser({ isBot: true });
    markEmailVerified(bot._id);
    await settle();
    expect((await readOnboarding(bot._id)).verifiedAt).toBeUndefined();
  });
});

describe('markSurface on the real User schema', () => {
  test.each(['inviteCardShownAt', 'inviteCardDismissedAt', 'byoOfferShownAt', 'welcomeShownAt'])('%s persists', async (mark) => {
    const user = await makeUser();
    markSurface(user._id, mark);
    const onboarding = await waitForField(user._id, mark);
    expect(onboarding[mark]).toBeInstanceOf(Date);
  });

  test('a second mark after a process reset keeps the first time and leaves other fields alone', async () => {
    const podOpenedAt = new Date('2026-10-01T00:00:00Z');
    const user = await makeUser({ onboarding: { podOpenedAt } });
    markSurface(user._id, 'inviteCardShownAt');
    const first = (await waitForField(user._id, 'inviteCardShownAt')).inviteCardShownAt;

    resetOnboardingMarksForTest();
    markSurface(user._id, 'inviteCardShownAt');
    await settle();

    const onboarding = await readOnboarding(user._id);
    expect(onboarding.inviteCardShownAt).toEqual(first);
    expect(onboarding.podOpenedAt).toEqual(podOpenedAt);
  });

  test('a bot user is never marked', async () => {
    const bot = await makeUser({ isBot: true });
    markSurface(bot._id, 'byoOfferShownAt');
    await settle();
    expect((await readOnboarding(bot._id)).byoOfferShownAt).toBeUndefined();
  });

  test('welcomeShownAt keeps the first render: a repeat load after a restart writes nothing', async () => {
    const user = await makeUser();
    markSurface(user._id, 'welcomeShownAt');
    const first = (await waitForField(user._id, 'welcomeShownAt')).welcomeShownAt;

    resetOnboardingMarksForTest();
    markSurface(user._id, 'welcomeShownAt');
    await settle();

    expect((await readOnboarding(user._id)).welcomeShownAt).toEqual(first);
  });

  test('welcomeShownAt is a no-op for an agent', async () => {
    const bot = await makeUser({ isBot: true });
    markSurface(bot._id, 'welcomeShownAt');
    await settle();
    expect((await readOnboarding(bot._id)).welcomeShownAt).toBeUndefined();
  });
});
