// POST /api/attribution/visit counts one first-touch arrival per ref per UTC
// day, keeps nothing about the visitor, and ignores anything that is not a
// short plain code.
const express = require('express');
const request = require('supertest');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const AttributionVisit = require('../../../models/AttributionVisit');
const router = require('../../../routes/attribution');

const handler = (() => {
  const layer = router.stack.find((entry) => entry.route?.path === '/attribution/visit' && entry.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();
const send = async (body) => {
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn(), json: jest.fn() };
  await handler({ body }, res);
  return res;
};

beforeAll(async () => {
  await setupMongoDb();
  await AttributionVisit.syncIndexes();
});
afterAll(closeMongoDb);
afterEach(clearMongoDb);

it('counts each arrival for the ref on today', async () => {
  await send({ ref: 'X' });
  const res = await send({ ref: 'x' });

  expect(res.status).toHaveBeenCalledWith(204);
  const rows = await AttributionVisit.find().lean();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ day: new Date().toISOString().slice(0, 10), ref: 'x', count: 2 });
  expect(Object.keys(rows[0]).sort()).toEqual(['__v', '_id', 'count', 'createdAt', 'day', 'ref', 'updatedAt']);
});

// Cofounder on #2281: the table is bounded. A day holds at most
// VISIT_REFS_PER_DAY distinct refs; a new ref past that counts as 'other', and a
// ref already counted that day keeps its own row.
it('past the daily ref cap, a new ref counts as other; a known one keeps its row', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await AttributionVisit.insertMany(Array.from({ length: AttributionVisit.VISIT_REFS_PER_DAY }, (_v, i) => ({
    day, ref: `seed-${i}`, count: 1,
  })));

  await send({ ref: 'brand-new' });
  await send({ ref: 'another-new' });
  await send({ ref: 'seed-3' });

  expect(await AttributionVisit.exists({ day, ref: 'brand-new' })).toBeNull();
  expect((await AttributionVisit.findOne({ day, ref: AttributionVisit.OTHER_REF }).lean()).count).toBe(2);
  expect((await AttributionVisit.findOne({ day, ref: 'seed-3' }).lean()).count).toBe(2);
});

// sprint-review on #2282: with a same-day check, junk codes spent the day's
// slots before a real campaign link arrived, and it was counted as overflow.
it('a ref counted on an earlier day keeps its own row after the day fills with junk', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await AttributionVisit.create({ day: '2026-10-01', ref: 'x', count: 3 });
  await AttributionVisit.insertMany(Array.from({ length: AttributionVisit.VISIT_REFS_PER_DAY }, (_v, i) => ({
    day, ref: `junk-${i}`, count: 1,
  })));

  await send({ ref: 'x' });

  expect((await AttributionVisit.findOne({ day, ref: 'x' }).lean()).count).toBe(1);
  expect(await AttributionVisit.exists({ day, ref: AttributionVisit.OTHER_REF })).toBeNull();
});

// Cofounder on #2282: a real ref named "other" must not share the overflow row.
it('the overflow row cannot be named by a real ref', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await send({ ref: 'other' });
  await AttributionVisit.insertMany(Array.from({ length: AttributionVisit.VISIT_REFS_PER_DAY }, (_v, i) => ({
    day, ref: `junk-${i}`, count: 1,
  })));

  await send({ ref: 'past-the-cap' });

  expect((await AttributionVisit.findOne({ day, ref: 'other' }).lean()).count).toBe(1);
  expect((await AttributionVisit.findOne({ day, ref: AttributionVisit.OTHER_REF }).lean()).count).toBe(1);
  expect(AttributionVisit.OTHER_REF).not.toBe('other');
});

it('drops a day row 180 days after it was first written', async () => {
  const indexes = await AttributionVisit.collection.indexes();
  const ttl = indexes.find((index) => index.key && index.key.createdAt === 1);
  expect(ttl && ttl.expireAfterSeconds).toBe(180 * 24 * 60 * 60);
});

// sprint-review on #2281 (S8): the limiter is the only bound on how fast a
// caller writes, and deleting it left every other test green.
it('the endpoint is rate-limited: the eleventh visit in a minute is refused', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const codes = [];
  for (let i = 0; i < 11; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).post('/api/attribution/visit')
      .set('cf-connecting-ip', '203.0.113.7')
      .send({ ref: 'x' });
    codes.push(res.status);
  }
  expect(codes.slice(0, 10)).toEqual(Array(10).fill(204));
  expect(codes[10]).toBe(429);
});

it('ignores a ref that is not a short plain code', async () => {
  const res = await send({ ref: '<script>alert(1)</script>' });
  await send({ ref: { $gt: '' } });
  await send({});

  expect(res.status).toHaveBeenCalledWith(204);
  expect(await AttributionVisit.countDocuments()).toBe(0);
});
