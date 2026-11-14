// F124 (CodeRabbit on #4112): pod conventions against the real Pod model and an
// in-memory MongoDB, so a dropped schema path or a wrong revision predicate
// fails here, where the unit test's mocks would pass.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, createTestUser, createTestPod } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const PodConventionsService = require('../../services/podConventionsService');

describe('pod conventions persistence', () => {
  let creator;
  let pod;

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Pod.deleteMany({})]);
    creator = await createTestUser(User, { username: 'alice', email: 'alice@example.com', isBot: false });
    pod = await createTestPod(Pod, creator._id, {
      focus: { goal: 'Ship', scope: 'Pilot', ownerUserId: creator._id, nextTaskIds: [], revision: 1 },
      focusRevision: 1,
    });
  });

  const reload = () => Pod.findById(pod._id).lean();
  const write = (expectedRevision, text) => PodConventionsService.update({
    podId: String(pod._id), userId: String(creator._id), expectedRevision, text,
  });

  test('set, reload, clear, reload: the clear keeps the revision and the neighbouring fields', async () => {
    await write(0, 'Reply in a thread.');
    let stored = await reload();
    expect(stored.conventions.text).toBe('Reply in a thread.');
    expect(String(stored.conventions.updatedBy)).toBe(String(creator._id));
    expect(stored.conventions.updatedAt).toBeInstanceOf(Date);
    expect(stored.conventionsRevision).toBe(1);

    const read = await PodConventionsService.read({ podId: String(pod._id), userId: String(creator._id) });
    expect(read).toMatchObject({ revision: 1, conventions: { text: 'Reply in a thread.', updatedBy: { label: 'alice' } } });

    await write(1, null);
    stored = await reload();
    expect(stored.conventions).toBeNull();
    expect(stored.conventionsRevision).toBe(2);
    // Untouched by either write.
    expect(stored.name).toBe('Test Pod');
    expect(stored.focus.goal).toBe('Ship');
    expect(stored.focusRevision).toBe(1);
    expect(stored.members.map(String)).toEqual([String(creator._id)]);

    // A stale revision after the clear is still refused.
    await expect(write(1, 'again')).rejects.toMatchObject({ status: 409, code: 'CONVENTIONS_CONFLICT' });
    await write(2, 'again');
    expect((await reload()).conventionsRevision).toBe(3);
  });

  test('two writes at the same revision: exactly one lands', async () => {
    // A barrier at the compare-and-swap: neither write reaches MongoDB until
    // both have read revision 0 and passed the service's own check, so it is
    // the database predicate that picks the winner (CodeRabbit on #4112).
    const original = Pod.findOneAndUpdate.bind(Pod);
    let arrived = 0;
    let release;
    const bothRead = new Promise((resolve) => { release = resolve; });
    const spy = jest.spyOn(Pod, 'findOneAndUpdate').mockImplementation((...args) => ({
      lean: async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothRead;
        return original(...args).lean();
      },
    }));
    let results;
    try {
      results = await Promise.allSettled([write(0, 'first'), write(0, 'second')]);
    } finally {
      spy.mockRestore();
    }
    expect(arrived).toBe(2);
    const landed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ status: 409, code: 'CONVENTIONS_CONFLICT' });
    const stored = await reload();
    expect(stored.conventionsRevision).toBe(1);
    expect(stored.conventions.text).toBe(landed[0].value.conventions.text);
  });

  test('a pod made before F124 (no revision field) takes its first write at revision 0', async () => {
    await Pod.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(pod._id)) }, { $unset: { conventionsRevision: '' } });
    await write(0, 'first');
    expect((await reload()).conventionsRevision).toBe(1);
  });
});
