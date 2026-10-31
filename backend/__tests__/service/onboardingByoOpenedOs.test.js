/**
 * byoOpenedOs round-trips through the real User schema: the enum admits the
 * four values markByoOpened writes, and the mark's write-once filter keeps the
 * first open's OS. The unit test (unit/services/onboardingMarks.test.js) pins
 * the update payload; this pins that the schema stores it.
 */
const User = require('../../models/User');
const { markByoOpened, resetOnboardingMarksForTest } = require('../../services/onboardingMarks');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const makeUser = (name) => User.create({
  username: name, email: `${name}@example.test`, password: 'Opened-os-123!',
});

const settle = async (id, predicate) => {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const row = await User.findById(id).lean();
    if (predicate(row)) return row;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
  return User.findById(id).lean();
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  resetOnboardingMarksForTest();
});

test.each(['mac', 'linux', 'windows', 'other'])('stores os=%s with the first-open time', async (os) => {
  const user = await makeUser(`opened-${os}`);
  markByoOpened(String(user._id), os);
  const row = await settle(user._id, (r) => r?.onboarding?.byoOpenedAt);
  expect(row.onboarding.byoOpenedAt).toBeInstanceOf(Date);
  expect(row.onboarding.byoOpenedOs).toBe(os);
});

test('an unknown value records the visit without an OS', async () => {
  const user = await makeUser('opened-ios');
  markByoOpened(String(user._id), 'ios');
  const row = await settle(user._id, (r) => r?.onboarding?.byoOpenedAt);
  expect(row.onboarding.byoOpenedAt).toBeInstanceOf(Date);
  expect(row.onboarding).not.toHaveProperty('byoOpenedOs');
});

test('a later open from another OS does not overwrite the first', async () => {
  const user = await makeUser('opened-twice');
  markByoOpened(String(user._id), 'windows');
  const first = await settle(user._id, (r) => r?.onboarding?.byoOpenedAt);
  resetOnboardingMarksForTest(); // as after a restart
  markByoOpened(String(user._id), 'mac');
  await new Promise((r) => setTimeout(r, 200));
  const row = await User.findById(user._id).lean();
  expect(row.onboarding.byoOpenedOs).toBe('windows');
  expect(row.onboarding.byoOpenedAt).toEqual(first.onboarding.byoOpenedAt);
});
