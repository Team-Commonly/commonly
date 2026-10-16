// POST /api/attribution/visit counts one first-touch arrival per ref per UTC
// day, keeps nothing about the visitor, and ignores anything that is not a
// short plain code.
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

beforeAll(setupMongoDb);
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

it('ignores a ref that is not a short plain code', async () => {
  const res = await send({ ref: '<script>alert(1)</script>' });
  await send({ ref: { $gt: '' } });
  await send({});

  expect(res.status).toHaveBeenCalledWith(204);
  expect(await AttributionVisit.countDocuments()).toBe(0);
});
