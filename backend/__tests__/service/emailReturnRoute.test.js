const express = require('express');
const request = require('supertest');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const User = require('../../models/User');
const { issueSessionToken } = require('../../services/sessionTokenService');
const emailReturns = require('../../services/emailReturnService');

// F519: POST /api/users/me/email-return records an email link's tag only under
// the usage-events consent rules (the switch, the EU/EEA/UK default, DNT/GPC)
// and always answers 204, so the reply says nothing about the tag.
describe('POST /api/users/me/email-return', () => {
  let app;
  let ip = 0;
  const TAG = `mention.${'a'.repeat(24)}`;
  const makeUser = (fields = {}) => User.create({
    username: `person-${Math.random().toString(16).slice(2)}`, email: `${Math.random()}@example.test`, password: 'pw-123456', ...fields,
  });
  const send = (user, headers = {}) => {
    let req = request(app).post('/api/users/me/email-return').set('cf-connecting-ip', `198.51.100.${++ip % 250}`)
      .set('Authorization', `Bearer ${issueSessionToken(user)}`);
    for (const [key, value] of Object.entries({ 'cf-ipcountry': 'US', ...headers })) req = req.set(key, value);
    return req.send({ tag: TAG });
  };
  let recorded;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'email-return-test';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/users', require('../../routes/users'));
  });
  beforeEach(() => { recorded = jest.spyOn(emailReturns, 'recordEmailReturn').mockResolvedValue(true); });
  afterEach(async () => { recorded.mockRestore(); await clearMongoDb(); });
  afterAll(closeMongoDb);

  it('records for a person with usage on by default', async () => {
    const user = await makeUser();
    expect((await send(user)).status).toBe(204);
    expect(recorded).toHaveBeenCalledWith(String(user._id), TAG);
  });

  it('records nothing when the person turned usage off', async () => {
    const user = await makeUser({ preferences: { usageEvents: false } });
    expect((await send(user)).status).toBe(204);
    expect(recorded).not.toHaveBeenCalled();
  });

  it('records nothing under the EU default until the person opts in', async () => {
    const user = await makeUser();
    expect((await send(user, { 'cf-ipcountry': 'DE' })).status).toBe(204);
    expect(recorded).not.toHaveBeenCalled();
    const optedIn = await makeUser({ preferences: { usageEvents: true } });
    await send(optedIn, { 'cf-ipcountry': 'DE' });
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  it('records nothing under a DNT or GPC signal, whatever the switch says', async () => {
    const user = await makeUser({ preferences: { usageEvents: true } });
    await send(user, { dnt: '1' });
    await send(user, { 'sec-gpc': '1' });
    expect(recorded).not.toHaveBeenCalled();
  });

  it('needs a signed-in person', async () => {
    const res = await request(app).post('/api/users/me/email-return').send({ tag: TAG });
    expect(res.status).toBe(401);
    expect(recorded).not.toHaveBeenCalled();
  });
});
