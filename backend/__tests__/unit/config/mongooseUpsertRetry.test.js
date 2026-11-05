// An upsert racing another upsert on a unique key is retried by MongoDB
// itself; FerretDB (self-hosted, Postgres-backed) surfaces the race to the
// client as E11000 or a Postgres deadlock instead. config/mongooseUpsertRetry
// retries those upserts in one place, and must never retry anything else.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const {
  installUpsertRetry,
  MAX_UPSERT_ATTEMPTS,
  FERRETDB_DEADLOCK_CODE,
} = require('../../../config/mongooseUpsertRetry');

const counterSchema = new mongoose.Schema({
  k: { type: String, required: true, unique: true },
  n: { type: Number, default: 0 },
});
const Counter = mongoose.models.UpsertRetryCounter
  || mongoose.model('UpsertRetryCounter', counterSchema);

const serverError = (code, message) => {
  const err = new mongoose.mongo.MongoServerError({ message, code });
  return err;
};

describe('mongooseUpsertRetry', () => {
  beforeAll(async () => {
    installUpsertRetry(mongoose);
    await setupMongoDb();
    await Counter.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  it('installing twice wraps exec only once', () => {
    const { exec } = mongoose.Query.prototype;
    installUpsertRetry(mongoose);
    expect(mongoose.Query.prototype.exec).toBe(exec);
  });

  it('retries an upsert that fails once with E11000, then resolves', async () => {
    const original = Counter.collection.updateOne;
    const spy = jest.spyOn(Counter.collection, 'updateOne')
      .mockImplementationOnce(() => Promise.reject(serverError(11000, 'Duplicate key violation')))
      .mockImplementation(function passthrough(...args) { return original.apply(this, args); });

    const res = await Counter.updateOne({ k: 'a' }, { $inc: { n: 1 } }, { upsert: true });

    expect(res.upsertedCount + res.modifiedCount).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    const doc = await Counter.findOne({ k: 'a' }).lean();
    expect(doc.n).toBe(1);
  });

  it('retries findOneAndUpdate upserts too', async () => {
    const original = Counter.collection.findOneAndUpdate;
    const spy = jest.spyOn(Counter.collection, 'findOneAndUpdate')
      .mockImplementationOnce(() => Promise.reject(serverError(FERRETDB_DEADLOCK_CODE, 'deadlock detected')))
      .mockImplementation(function passthrough(...args) { return original.apply(this, args); });

    const doc = await Counter.findOneAndUpdate(
      { k: 'b' },
      { $inc: { n: 1 } },
      { upsert: true, new: true },
    ).lean();

    expect(doc.n).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries the FerretDB code-1 "violates exclusion constraint" form of a lost upsert race', async () => {
    const original = Counter.collection.findOneAndUpdate;
    const spy = jest.spyOn(Counter.collection, 'findOneAndUpdate')
      .mockImplementationOnce(() => Promise.reject(serverError(
        1,
        'ERROR: conflicting key value violates exclusion constraint "upsertretrycounters_k_1_idx" (SQLSTATE 23P01)',
      )))
      .mockImplementation(function passthrough(...args) { return original.apply(this, args); });

    const doc = await Counter.findOneAndUpdate({ k: 'x1' }, { $inc: { n: 1 } }, { upsert: true, new: true }).lean();

    expect(doc.n).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries the FerretDB code-1 "deadlock detected" form, but no other code-1 error', async () => {
    const original = Counter.collection.findOneAndUpdate;
    const spy = jest.spyOn(Counter.collection, 'findOneAndUpdate')
      .mockImplementationOnce(() => Promise.reject(serverError(1, 'deadlock detected')))
      .mockImplementationOnce(() => Promise.reject(serverError(1, 'connection reset by peer')))
      .mockImplementation(function passthrough(...args) { return original.apply(this, args); });

    await expect(Counter.findOneAndUpdate({ k: 'x2' }, { $inc: { n: 1 } }, { upsert: true }))
      .rejects.toThrow('connection reset by peer');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and rethrows the original error', async () => {
    const errors = [];
    const spy = jest.spyOn(Counter.collection, 'updateOne').mockImplementation(() => {
      const err = serverError(FERRETDB_DEADLOCK_CODE, `deadlock detected #${errors.length}`);
      errors.push(err);
      return Promise.reject(err);
    });

    let caught;
    try {
      await Counter.updateOne({ k: 'c' }, { $inc: { n: 1 } }, { upsert: true });
    } catch (err) {
      caught = err;
    }

    expect(MAX_UPSERT_ATTEMPTS).toBe(5);
    expect(spy).toHaveBeenCalledTimes(MAX_UPSERT_ATTEMPTS);
    expect(caught).toBe(errors[errors.length - 1]);
    expect(caught.code).toBe(FERRETDB_DEADLOCK_CODE);
  });

  it('never retries a non-upsert write: its E11000 is a real uniqueness violation', async () => {
    const spy = jest.spyOn(Counter.collection, 'updateOne')
      .mockImplementation(() => Promise.reject(serverError(11000, 'E11000 duplicate key error')));

    await expect(Counter.updateOne({ k: 'd' }, { $set: { k: 'e' } })).rejects.toMatchObject({ code: 11000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not retry an upsert that fails with a non-transient error', async () => {
    const spy = jest.spyOn(Counter.collection, 'updateOne')
      .mockImplementation(() => Promise.reject(serverError(2, 'BadValue')));

    await expect(Counter.updateOne({ k: 'f' }, { $inc: { n: 1 } }, { upsert: true }))
      .rejects.toMatchObject({ code: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent bulkWrite upsert ($set only) on E11000', async () => {
    const original = Counter.collection.bulkWrite;
    const spy = jest.spyOn(Counter.collection, 'bulkWrite')
      .mockImplementationOnce((ops, opts, cb) => {
        const err = serverError(11000, 'Duplicate key violation');
        if (typeof cb === 'function') return cb(err);
        return Promise.reject(err);
      })
      .mockImplementation(function passthrough(...args) { return original.apply(this, args); });

    await Counter.bulkWrite([
      { updateOne: { filter: { k: 'g' }, update: { $set: { n: 7 } }, upsert: true } },
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect((await Counter.findOne({ k: 'g' }).lean()).n).toBe(7);
  });

  it('does not retry a bulkWrite whose ops are not all idempotent upserts', async () => {
    const spy = jest.spyOn(Counter.collection, 'bulkWrite')
      .mockImplementation((ops, opts, cb) => {
        const err = serverError(11000, 'Duplicate key violation');
        if (typeof cb === 'function') return cb(err);
        return Promise.reject(err);
      });

    await expect(Counter.bulkWrite([
      { updateOne: { filter: { k: 'h' }, update: { $inc: { n: 1 } }, upsert: true } },
    ])).rejects.toMatchObject({ code: 11000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // In-memory MongoDB passes this without the retry (it retries internally).
  // It is here for the FerretDB CI leg, where one round of 20 loses the race
  // only some of the time; five rounds on fresh keys make a regression show.
  it('20 concurrent $inc upserts on one unique key end as one doc with n=20', async () => {
    for (let round = 0; round < 5; round += 1) {
      const k = `race-${round}`;
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => (
        Counter.updateOne({ k }, { $inc: { n: 1 } }, { upsert: true })
      )));

      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      // eslint-disable-next-line no-await-in-loop
      const docs = await Counter.find({ k }).lean();
      expect(docs).toHaveLength(1);
      expect(docs[0].n).toBe(20);
    }
  });
});
