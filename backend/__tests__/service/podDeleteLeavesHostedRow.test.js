process.env.PG_HOST = '';

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// TASK-147, path 2 of 5: `DELETE /api/pods/:id`.
//
// `podController.deletePod` removes a pod's connector rows with one filter —
// `Integration.deleteMany({ podId })` — and a hosted-mcp row carries no `podId`
// at all, because the row is per-person rather than per-pod (scope §2, and
// `podId` is required only when `scope: 'pod'`). So the pod delete cannot reach
// a hosted row, and with it cannot strand the grants a hosted row holds.
//
// "The row survived" is worth nothing on its own here: it is also what a pod
// delete that never ran, or that failed before the integration step, produces.
// The arm therefore deletes three rows with the same call and asserts where
// each one lands — one that the filter MATCHES, which must go, and two that it
// cannot match (a hosted row and a linked personal one), which must stay. The
// row that goes is the positive control: it holds the statement that the
// sequence ran in this request.
//
// The rows are real documents and the filter is really run by mongod. A mocked
// `deleteMany` could only report the selector it was handed, which is the claim
// rather than the evidence for it.
const OWNER = new mongoose.Types.ObjectId();

const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const podController = require('../../controllers/podController');

const hostedRow = (podId) => ({
  scope: 'user',
  type: 'hosted-mcp',
  status: 'connected',
  createdBy: OWNER,
  config: { entryId: 'linear', intake: 'oauth', credentialRef: 'secret-access-1' },
});

// Production mints this shape with a pod (the channel connectors), and the
// filter below matches it by the same field the hosted row lacks.
const podScopedRow = (podId) => ({
  scope: 'pod',
  type: 'telegram',
  status: 'connected',
  podId,
  createdBy: OWNER,
  config: { chatId: '42', chatType: 'private' },
});

// A linked personal row (webhookProjector's shape) is the second thing the pod
// delete must not touch, and it is the shape that says the miss is about
// `podId` and not about `scope`.
const linkedPersonalRow = () => ({
  scope: 'user',
  type: 'telegram',
  status: 'connected',
  createdBy: OWNER,
  config: { chatId: '99', chatType: 'private', linkedUserId: String(OWNER) },
});

const runDelete = async (podId) => {
  const calls = [];
  const req = { params: { id: String(podId) }, userId: String(OWNER), user: { id: String(OWNER), role: 'member' } };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { calls.push(body); return this; },
  };
  await podController.deletePod(req, res);
  return { res, body: calls[calls.length - 1] };
};

describe('DELETE /api/pods/:id — a carried pod filter cannot reach a hosted row', () => {
  let filterSpy;

  beforeAll(async () => {
    await setupMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    // Spied so the site is asserted as well as the effect, and so the real
    // implementation still runs: a spy without its original would make the
    // three "where did it land" assertions vacuous.
    filterSpy = jest.spyOn(Integration, 'deleteMany');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  test('the hosted row and a linked personal row survive; the pod-scoped row does not', async () => {
    const pod = await Pod.create({ name: 'hosted-delete-witness', createdBy: OWNER });
    const hosted = await Integration.create(hostedRow(pod._id));
    const podScoped = await Integration.create(podScopedRow(pod._id));
    const linked = await Integration.create(linkedPersonalRow());

    const { res, body } = await runDelete(pod._id);

    expect(res.statusCode).toBe(200);
    expect(body.msg).toBe('Pod deleted');

    // The selector the controller ran. Named here so a failure says whether the
    // query moved or the row shape did.
    expect(filterSpy).toHaveBeenCalledWith({ podId: String(pod._id) });

    // Positive control first: the same call removed the row the filter matches,
    // so the survivals below are the filter's shape and not an unrun sequence.
    expect(await Integration.findById(podScoped._id)).toBeNull();

    const hostedAfter = await Integration.findById(hosted._id);
    expect(hostedAfter).not.toBeNull();
    expect(hostedAfter.config.credentialRef).toBe('secret-access-1');
    expect(await Integration.findById(linked._id)).not.toBeNull();
  });

  test('the miss is the absent field, run as a query rather than argued', async () => {
    const pod = await Pod.create({ name: 'hosted-delete-filter', createdBy: OWNER });
    const hosted = await Integration.create(hostedRow(pod._id));
    const podScoped = await Integration.create(podScopedRow(pod._id));

    // The same filter, one field, two rows: this is what the controller's call
    // evaluates to. `$exists` is spelled out because a filter on a MISSING
    // field is the whole mechanism — a row that carried `podId: null` would be
    // matched by `{ podId }`'s type bracketing and this arm would fail.
    const matched = await Integration.find({ podId: String(pod._id) }).select('_id').lean();
    const ids = matched.map((row) => String(row._id));
    expect(ids).toContain(String(podScoped._id));
    expect(ids).not.toContain(String(hosted._id));
    expect(await Integration.countDocuments({ podId: { $exists: false } })).toBe(1);
  });
});
