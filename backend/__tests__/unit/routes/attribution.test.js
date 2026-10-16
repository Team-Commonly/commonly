// POST /api/attribution/visit counts one first-touch arrival per ref per UTC
// day, keeps nothing about the visitor, and ignores anything that is not a
// short plain code.
const express = require('express');
const request = require('supertest');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const AttributionVisit = require('../../../models/AttributionVisit');
const SystemSetting = require('../../../models/SystemSetting');
const { clearCampaignRefsCache, CACHE_MS, MAX_CAMPAIGN_REFS } = require('../../../services/attributionCampaignRefs');
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
afterEach(async () => {
  await clearMongoDb();
  clearCampaignRefsCache();
});

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

// sprint-review on #2282: junk could spend a day's slots before a real campaign
// link arrived, which was then counted as overflow. Cofounder's call: campaign
// codes are a list (system_settings 'attribution.refs'), and they always keep
// their own row; everything else competes for the day's cap, afresh each day.
const today = () => new Date().toISOString().slice(0, 10);
const fillWithJunk = (day) => AttributionVisit.insertMany(
  Array.from({ length: AttributionVisit.VISIT_REFS_PER_DAY }, (_v, i) => ({ day, ref: `junk-${i}`, count: 1 })),
);
const listCampaigns = (value) => SystemSetting.create({ key: 'attribution.refs', value });
const rowFor = async (ref) => AttributionVisit.findOne({ day: today(), ref }).lean();

it('a listed campaign code keeps its own row after the day fills with junk', async () => {
  await listCampaigns(['x', 'x-thread']);
  await fillWithJunk(today());

  await send({ ref: 'x-thread' });

  expect((await rowFor('x-thread')).count).toBe(1);
  expect(await rowFor(AttributionVisit.OTHER_REF)).toBeNull();
});

it('junk counted on an earlier day gets no pass on a full day', async () => {
  await AttributionVisit.create({ day: '2026-10-01', ref: 'junk-old', count: 9 });
  await fillWithJunk(today());

  await send({ ref: 'junk-old' });

  expect(await rowFor('junk-old')).toBeNull();
  expect((await rowFor(AttributionVisit.OTHER_REF)).count).toBe(1);
});

it.each([
  ['no settings row', null],
  ['an empty list', []],
  ['a value that is not a list', 'x,hn'],
])('%s means the list is just x, never "allow all"', async (_label, value) => {
  if (value !== null) await listCampaigns(value);
  await fillWithJunk(today());

  await send({ ref: 'x' });
  await send({ ref: 'hn' });

  expect((await rowFor('x')).count).toBe(1);
  expect(await rowFor('hn')).toBeNull();
  expect((await rowFor(AttributionVisit.OTHER_REF)).count).toBe(1);
});

it('each list entry passes the ref rule: bad ones are ignored, good ones normalised', async () => {
  await listCampaigns(['<b>x</b>', 'REDDIT', 7, { $gt: '' }]);
  await fillWithJunk(today());

  await send({ ref: 'reddit' });

  expect((await rowFor('reddit')).count).toBe(1);
});

it('the list is read at most once a minute, then again', async () => {
  await listCampaigns(['x']);
  const read = jest.spyOn(SystemSetting, 'findOne');
  const now = jest.spyOn(Date, 'now');
  now.mockReturnValue(1_000_000);

  await send({ ref: 'x' });
  await send({ ref: 'li' });
  expect(read).toHaveBeenCalledTimes(1);

  now.mockReturnValue(1_000_000 + CACHE_MS + 1);
  await send({ ref: 'x' });
  expect(read).toHaveBeenCalledTimes(2);
  read.mockRestore();
  now.mockRestore();
});

// sprint-review on #2283 (E6): a failed read must not pin the list to ['x'] for
// a minute, or a Mongo blip would push every other campaign code into overflow.
it('a failed list read is not cached: the next visit reads it again', async () => {
  await listCampaigns(['x', 'li']);
  await fillWithJunk(today());
  const real = SystemSetting.findOne.bind(SystemSetting);
  const read = jest.spyOn(SystemSetting, 'findOne')
    .mockImplementationOnce(() => { throw new Error('mongo blip'); })
    .mockImplementation((...args) => real(...args));

  await send({ ref: 'li' });
  await send({ ref: 'li' });

  expect(read).toHaveBeenCalledTimes(2);
  // The first visit fell back to ['x'] and overflowed; the second read the list.
  expect((await rowFor(AttributionVisit.OTHER_REF)).count).toBe(1);
  expect((await rowFor('li')).count).toBe(1);
  read.mockRestore();
});

// sprint-review on #2283 (E7): campaign rows do not use up the day's 50 slots,
// so the ceiling for ordinary refs stays 50 however long the list grows.
it('campaign rows do not count against the daily cap', async () => {
  await listCampaigns(['x', 'li']);
  await AttributionVisit.insertMany([
    { day: today(), ref: 'x', count: 1 },
    { day: today(), ref: 'li', count: 1 },
    ...Array.from(
      { length: AttributionVisit.VISIT_REFS_PER_DAY - 1 },
      (_v, i) => ({ day: today(), ref: `junk-${i}`, count: 1 }),
    ),
  ]);

  await send({ ref: 'fiftieth' });

  expect((await rowFor('fiftieth')).count).toBe(1);
});

it(`entries past ${MAX_CAMPAIGN_REFS} are ignored`, async () => {
  await listCampaigns([...Array.from({ length: MAX_CAMPAIGN_REFS }, (_v, i) => `c-${i}`), 'late-code']);
  await fillWithJunk(today());

  await send({ ref: 'late-code' });

  expect(await rowFor('late-code')).toBeNull();
});

it('an unreadable list means x', async () => {
  const read = jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => { throw new Error('mongo blip'); });
  await fillWithJunk(today());

  await send({ ref: 'x' });

  expect((await rowFor('x')).count).toBe(1);
  read.mockRestore();
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
