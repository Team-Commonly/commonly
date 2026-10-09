// TASK-151 — service tier. The unit tests pin the query SHAPE; this pins what
// that shape costs, by counting what Mongo would actually return for it.
//
// The defect was not a slow query, it was the wrong query: `getAllPods` fetched
// every pod on the instance, populated members across all of them, sorted them
// in memory, and then discarded all but the caller's in JS. The fix is that the
// membership predicate reaches Mongo, so the count here is the assertion that
// matters — revert the push-down and it goes from 1 to every pod in the fixture.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const podController = require('../../controllers/podController');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const FOREIGN_PODS = 300;

const callGetAllPods = async (userId) => {
  const req = { query: {}, userId: String(userId), user: {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await podController.getAllPods(req, res);
  return { status: res.status.mock.calls.length ? res.status.mock.calls[0][0] : 200, body: res.json.mock.calls[0][0] };
};

describe('getAllPods cost is proportional to the caller, not the instance (TASK-151)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  it('asks Mongo for the caller\'s pods only, on an instance full of other pods', async () => {
    const me = new mongoose.Types.ObjectId();
    // User rows have to exist or `populate('members')` leaves nulls in the
    // populated array, which is a different (also real) failure mode.
    const others = Array.from({ length: 40 }, () => new mongoose.Types.ObjectId());
    await User.create([
      { _id: me, username: 'listing-me', email: 'listing-me@example.com', password: 'x' },
      ...others.map((id, i) => ({ _id: id, username: `listing-u${i}`, email: `listing-u${i}@example.com`, password: 'x' })),
    ]);
    await Pod.create({ name: 'Mine', type: 'team', createdBy: me, members: [me] });
    await Pod.insertMany(Array.from({ length: FOREIGN_PODS }, (_, i) => ({
      name: `Foreign ${i}`,
      type: 'team',
      createdBy: others[i % others.length],
      members: [others[i % others.length], others[(i + 3) % others.length]],
    })));

    const spy = jest.spyOn(Pod, 'find');
    const { status, body } = await callGetAllPods(me);

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(String(body[0].name)).toBe('Mine');

    const [query] = spy.mock.calls[0];
    // Forward control: the fixture really is an instance with other pods in it.
    expect(await Pod.countDocuments({ type: { $ne: 'agent-admin' } })).toBe(FOREIGN_PODS + 1);
    // The assertion under test: the query the handler sends matches ONLY mine.
    expect(await Pod.countDocuments(query)).toBe(1);
  });

  it('still returns exactly the caller\'s pods when the id is not castable', async () => {
    // Fallback path: an uncastable caller id cannot go into the query, so the
    // JS filter has to keep doing the work. Behaviour must be unchanged.
    const me = new mongoose.Types.ObjectId();
    await User.create({ _id: me, username: 'listing-me2', email: 'listing-me2@example.com', password: 'x' });
    await Pod.create({ name: 'Mine', type: 'team', createdBy: me, members: [me] });

    const spy = jest.spyOn(Pod, 'find');
    const { body } = await callGetAllPods('me');

    expect(body).toEqual([]);
    const [query] = spy.mock.calls[0];
    expect(query.members).toBeUndefined();
  });
});
