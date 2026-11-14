// POST /api/attribution/landing counts every landing per UTC day by (ref,
// referrer site), with or without a ref, and keeps nothing about the visitor.
// Earned 2026-11-14 (D315, F528): attribution_visits only counted arrivals with
// a ?ref, so a week's read could not say whether X, a listing or PH sent anyone.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { clearCampaignRefsCache } = require('../../../services/attributionCampaignRefs');
const LandingVisit = require('../../../models/LandingVisit');
const router = require('../../../routes/attribution');

const handler = (() => {
  const layer = router.stack.find((entry) => entry.route?.path === '/attribution/landing' && entry.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();
const send = async (body) => {
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn(), json: jest.fn() };
  await handler({ body }, res);
  return res;
};
const today = () => new Date().toISOString().slice(0, 10);
const rows = () => LandingVisit.find({}, { _id: 0, day: 1, ref: 1, referrer: 1, count: 1 }).sort({ ref: 1, referrer: 1 }).lean();

beforeAll(async () => {
  await setupMongoDb();
  await LandingVisit.syncIndexes();
});
afterAll(closeMongoDb);
afterEach(async () => {
  await clearMongoDb();
  clearCampaignRefsCache();
});

it('counts a landing with no ref and no referrer, and one from a site with no ref', async () => {
  const res = await send({});
  await send({ referrer: 'x.com' });
  await send({ referrer: 'x.com' });

  expect(res.status).toHaveBeenCalledWith(204);
  expect(await rows()).toEqual([
    { day: today(), ref: LandingVisit.NONE, referrer: 'x.com', count: 2 },
    { day: today(), ref: LandingVisit.NONE, referrer: LandingVisit.NONE, count: 1 },
  ]);
});

it('keys by ref and referrer together, lower-cased, with www. folded', async () => {
  await send({ ref: 'DevHunt', referrer: 'WWW.DevHunt.org' });
  await send({ ref: 'devhunt', referrer: 'devhunt.org' });
  await send({ ref: 'devhunt' });

  expect(await rows()).toEqual([
    { day: today(), ref: 'devhunt', referrer: 'devhunt.org', count: 2 },
    { day: today(), ref: 'devhunt', referrer: LandingVisit.NONE, count: 1 },
  ]);
});

it('stores only day, ref, referrer and count', async () => {
  await send({ ref: 'x', referrer: 't.co', path: '/guides/a', email: 'a@b.c', ua: 'Mozilla' });

  const [row] = await LandingVisit.find().lean();
  expect(Object.keys(row).sort()).toEqual(['__v', '_id', 'count', 'createdAt', 'day', 'ref', 'referrer', 'updatedAt']);
});

it('a click inside our own site is not a landing', async () => {
  for (const referrer of ['commonly.me', 'www.commonly.me', 'api.commonly.me', 'localhost']) await send({ referrer });

  expect(await rows()).toEqual([]);
});

it.each([
  ['a full URL', 'https://x.com/sam/status/1'],
  ['a path', 'x.com/home'],
  ['a junk string', '<script>'],
  ['a single label', 'intranet'],
  ['an IPv4 address', '203.0.113.5'],
  ['a private IPv4 address', '192.168.1.20'],
  ['a non-string', { $gt: '' }],
])('a referrer that is %s counts as other', async (_label, referrer) => {
  await send({ referrer });

  expect(await rows()).toEqual([{ day: today(), ref: LandingVisit.NONE, referrer: LandingVisit.OTHER, count: 1 }]);
});

it('a ref that fails the ref rule counts as other', async () => {
  await send({ ref: 'not a ref!', referrer: 'x.com' });

  expect(await rows()).toEqual([{ day: today(), ref: LandingVisit.OTHER, referrer: 'x.com', count: 1 }]);
});

it('past the daily cap a new pair counts as other/other; a known pair keeps its row', async () => {
  await LandingVisit.insertMany(Array.from({ length: LandingVisit.LANDING_ROWS_PER_DAY }, (_v, i) => ({
    day: today(), ref: LandingVisit.OTHER, referrer: `junk-${i}.example`, count: 1,
  })));

  await send({ referrer: 'blog.example' });
  await send({ ref: 'zz', referrer: 'another.example' });
  await send({ ref: 'bad ref', referrer: 'junk-3.example' });

  expect(await LandingVisit.exists({ day: today(), referrer: 'blog.example' })).toBeNull();
  expect((await LandingVisit.findOne({ day: today(), ref: LandingVisit.OTHER, referrer: LandingVisit.OTHER }).lean()).count).toBe(2);
  expect((await LandingVisit.findOne({ day: today(), referrer: 'junk-3.example' }).lean()).count).toBe(2);
});

it('a failed count still answers 204', async () => {
  const spy = jest.spyOn(LandingVisit, 'updateOne').mockRejectedValueOnce(new Error('mongo down'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const res = await send({ referrer: 'x.com' });

  expect(res.status).toHaveBeenCalledWith(204);
  spy.mockRestore();
  warn.mockRestore();
});

// Review on F528: 200 junk hostnames early in a day would push x.com into
// OTHER for the rest of it. The sites a launch read asks about keep their row.
it('a known site with no ref or a campaign ref keeps its row after junk fills the day', async () => {
  await LandingVisit.insertMany(Array.from({ length: LandingVisit.LANDING_ROWS_PER_DAY }, (_v, i) => ({
    day: today(), ref: LandingVisit.NONE, referrer: `junk-${i}.example`, count: 1,
  })));

  await send({ referrer: 'x.com' });
  await send({ ref: 'x', referrer: 't.co' });
  await send({ ref: 'made-up', referrer: 'x.com' });

  expect((await LandingVisit.findOne({ day: today(), ref: LandingVisit.NONE, referrer: 'x.com' }).lean()).count).toBe(1);
  expect((await LandingVisit.findOne({ day: today(), ref: 'x', referrer: 't.co' }).lean()).count).toBe(1);
  expect(await LandingVisit.exists({ day: today(), ref: 'made-up' })).toBeNull();
  expect((await LandingVisit.findOne({ day: today(), ref: LandingVisit.OTHER, referrer: LandingVisit.OTHER }).lean()).count).toBe(1);
});

it('protected pairs do not count against the cap', async () => {
  await LandingVisit.insertMany(['x.com', 't.co', 'github.com'].map((referrer) => ({ day: today(), ref: LandingVisit.NONE, referrer, count: 5 })));
  await LandingVisit.insertMany(Array.from({ length: LandingVisit.LANDING_ROWS_PER_DAY - 1 }, (_v, i) => ({
    day: today(), ref: LandingVisit.NONE, referrer: `junk-${i}.example`, count: 1,
  })));

  await send({ referrer: 'blog.example' });

  expect((await LandingVisit.findOne({ day: today(), referrer: 'blog.example' }).lean()).count).toBe(1);
});

it('has its own rate limit, apart from /visit', () => {
  const limiterOf = (path) => router.stack.find((e) => e.route?.path === path).route.stack[0].handle;
  expect(limiterOf('/attribution/landing')).not.toBe(limiterOf('/attribution/visit'));
});

