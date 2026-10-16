// POST /api/users/me/timezone: the app shell sends the browser's IANA zone
// once, and the daily digest goes out at 08:00 there (TASK-257 Phase 2b). Set
// once and never overwritten; a zone this runtime does not know is ignored.
const request = require('supertest');
const express = require('express');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const userId = req.get('authorization');
  req.user = { id: userId };
  req.userId = userId;
  next();
});

const User = require('../../../models/User');
const routes = require('../../../routes/users');

const app = express();
app.use(express.json());
app.use('/api/users', routes);

let serial = 0;
const person = async () => {
  serial += 1;
  return User.create({ username: `tz-${serial}`, email: `tz-${serial}@example.com`, password: 'Password123!' });
};
const send = (user, timeZone) => request(app).post('/api/users/me/timezone')
  .set('authorization', String(user._id)).send({ timeZone });
const zoneOf = async (user) => (await User.findById(user._id).lean()).timezone;

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(clearMongoDb);

it('keeps the first zone it is sent, and never overwrites it', async () => {
  const user = await person();

  await send(user, 'America/Los_Angeles').expect(204);
  await send(user, 'Europe/Berlin').expect(204);

  expect(await zoneOf(user)).toBe('America/Los_Angeles');
});

it.each([
  ['an unknown zone', 'Mars/Phobos'],
  ['markup', '<b>UTC</b>'],
  ['an object', { $gt: '' }],
  ['nothing', undefined],
])('ignores %s and still answers 204', async (_label, timeZone) => {
  const user = await person();

  await send(user, timeZone).expect(204);

  expect(await zoneOf(user)).toBeUndefined();
});

it('never sets a zone on a bot', async () => {
  const bot = await person();
  await User.updateOne({ _id: bot._id }, { $set: { isBot: true } });

  await send(bot, 'UTC').expect(204);

  expect(await zoneOf(bot)).toBeUndefined();
});
