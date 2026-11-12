const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { issueSessionToken } = require('../../services/sessionTokenService');
const { DAILY_CAP } = require('../../services/usageEvents');

// D286 usage events (F399). Each block pins one load-bearing rule of the spec:
// allowlists, server-set fields, pod rules, consent by region and signal, the
// daily cap, logged-out counters with no visitor state, and the TTLs.
describe('usage events (D286)', () => {
  let app;
  let ip = 0;
  const rows = () => mongoose.connection.db.collection('ui_events');
  const counts = () => mongoose.connection.db.collection('ui_daily_counts');
  const makeUser = (fields = {}) => User.create({
    username: `person-${Math.random().toString(16).slice(2)}`, email: `${Math.random()}@example.test`, password: 'pw-123456', ...fields,
  });
  // A US request by default, so recording is on unless a test says otherwise.
  const post = (user, body, headers = {}) => {
    let req = request(app).post('/api/stats/ui-event').set('cf-connecting-ip', `198.51.100.${++ip % 250}`)
      .set('Authorization', `Bearer ${issueSessionToken(user)}`);
    for (const [key, value] of Object.entries({ 'cf-ipcountry': 'US', ...headers })) req = req.set(key, value);
    return req.send(body);
  };
  const hit = (body, headers = {}) => {
    let req = request(app).post('/api/stats/public-hit').set('cf-connecting-ip', `203.0.113.${++ip % 250}`);
    for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
    return req.send(body);
  };
  const setting = (user, headers = {}) => {
    let req = request(app).get('/api/users/me/usage-events').set('Authorization', `Bearer ${issueSessionToken(user)}`);
    for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
    return req;
  };
  const choose = (user, usageEvents) => request(app).put('/api/users/me/usage-events')
    .set('cf-connecting-ip', `192.0.2.${++ip % 250}`)
    .set('Authorization', `Bearer ${issueSessionToken(user)}`).send({ usageEvents });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'usage-events-test';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/stats', require('../../routes/stats'));
    app.use('/api/users', require('../../routes/users'));
  });
  afterEach(async () => {
    // clearMongoDb empties model collections; these two are written raw.
    await rows().deleteMany({});
    await counts().deleteMany({});
    await clearMongoDb();
  });
  afterAll(closeMongoDb);

  describe('the failed Settings read count (F399)', () => {
    const states = async () => Object.fromEntries((await counts().find({ name: 'usage-drop' }).toArray())
      .map((row) => [row.value, row.n]));
    const failed = (user, body, headers = {}) => {
      let req = request(app).post('/api/stats/usage-state').set('cf-connecting-ip', `198.51.100.${++ip % 250}`)
        .set('Authorization', `Bearer ${issueSessionToken(user)}`);
      for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
      return req.send(body);
    };
    // The read counts without holding its response, so wait for the writes to
    // land, then a further tick so a write that shouldn't exist has had time to.
    const tick = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const settle = async (total) => {
      for (let i = 0; i < 100; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const n = Object.values(await states()).reduce((a, b) => a + b, 0);
        if (n >= total) { await tick(150); return; }
        // eslint-disable-next-line no-await-in-loop
        await tick(20);
      }
      throw new Error(`expected ${total} counted loads, saw ${JSON.stringify(await states())}`);
    };

    it("counts nothing from the Settings read, whatever the person chose, and no internal account's failed read", async () => {
      const unset = await makeUser();
      const off = await makeUser({ preferences: { usageEvents: false } });
      const admin = await makeUser({ role: 'admin' });
      await setting(unset, { 'cf-ipcountry': 'DE' }).expect(200);
      await setting(off, { 'cf-ipcountry': 'US' }).expect(200);
      await setting(unset, { 'cf-ipcountry': 'US' }).expect(200);
      await failed(admin, { reason: 'settings-get-failed' }).expect(204);
      await failed(unset, { reason: 'settings-get-failed' }).expect(204);
      await settle(1);
      expect(await states()).toEqual({ 'settings-get-failed': 1 });
    });

    it('holds only the day, the reason and a count, nothing about the person', async () => {
      const user = await makeUser();
      await failed(user, { reason: 'settings-get-failed' }).expect(204);
      const [row] = await counts().find({ name: 'usage-drop' }).toArray();
      expect(Object.keys(row).sort()).toEqual(['_id', 'day', 'dayStart', 'n', 'name', 'page', 'refTag', 'value']);
      expect(row._id).toBe(`${row.day}|usage-drop|settings-get-failed`);
      expect(JSON.stringify(row)).not.toContain(String(user._id));
      expect(JSON.stringify(row)).not.toContain(user.username);
    });

    it('counts a failed read from a bare reason, and refuses any other body', async () => {
      const user = await makeUser();
      await failed(user, { reason: 'settings-get-failed' }).expect(204);
      await failed(user, { reason: 'settings-get-failed', screen: '/' }).expect(400);
      await failed(user, { reason: 'saved-off' }).expect(400);
      await failed(user, {}).expect(400);
      await failed(user, { reason: 'settings-get-failed' }, { dnt: '1' }).expect(204);
      expect(await states()).toEqual({ 'settings-get-failed': 1 });
    });

    it('needs a signed-in caller for the failed-read count', async () => {
      await request(app).post('/api/stats/usage-state').send({ reason: 'settings-get-failed' }).expect(401);
      expect(await states()).toEqual({});
    });
  });

  it('stores an allowlisted event with server-set fields and only enum props', async () => {
    const user = await makeUser();
    const forged = new mongoose.Types.ObjectId();
    const res = await post(user, {
      name: 'welcome-start-click', screen: '/', userId: String(forged), at: '2001-01-01', isInternal: true,
      props: { start: 'byo', note: 'typed text', extra: 'x' },
    });
    expect(res.status).toBe(204);
    const [row] = await rows().find().toArray();
    expect(String(row.userId)).toBe(String(user._id));
    expect(row.at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row).toMatchObject({ name: 'welcome-start-click', screen: '/', isInternal: false, props: { start: 'byo' } });
  });

  it('drops a prop value outside its enum and maps an unknown screen to "other"', async () => {
    const user = await makeUser();
    await post(user, { name: 'welcome-start-click', screen: '/pods/65f0a1b2c3d4e5f6a7b8c9d0', props: { start: 'my secret plan' } }).expect(204);
    const [row] = await rows().find().toArray();
    expect(row.screen).toBe('other');
    expect(row.props).toBeUndefined();
  });

  it('keeps a get-started-click step from its enum and drops any other (D288)', async () => {
    const user = await makeUser();
    await post(user, { name: 'get-started-click', screen: '/pods/:podId', props: { step: 'first-task' } }).expect(204);
    await post(user, { name: 'get-started-click', screen: '/pods/:podId', props: { step: 'invite-teammate' } }).expect(204);
    const found = await rows().find({ name: 'get-started-click' }).sort({ _id: 1 }).toArray();
    expect(found.map((row) => row.props)).toEqual([{ step: 'first-task' }, undefined]);
  });

  it('keeps the teammate card\'s where prop only for workspace or pod (D288)', async () => {
    const user = await makeUser();
    await post(user, { name: 'teammate-card-shown', screen: '/', props: { where: 'workspace' } }).expect(204);
    await post(user, { name: 'teammate-card-click', screen: '/', props: { where: 'https://x.test/?q=1' } }).expect(204);
    await post(user, { name: 'teammate-card-dismiss', screen: '/', props: { where: 'pod' } }).expect(204);
    const stored = await rows().find().sort({ _id: 1 }).toArray();
    expect(stored.map((row) => [row.name, row.props])).toEqual([
      ['teammate-card-shown', { where: 'workspace' }],
      ['teammate-card-click', undefined],
      ['teammate-card-dismiss', { where: 'pod' }],
    ]);
  });

  it('answers an unknown name with a 400 that never echoes it, and stores nothing', async () => {
    const user = await makeUser();
    const res = await post(user, { name: 'cm_agent_leaked-token', screen: '/' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('cm_agent');
    expect(await rows().countDocuments()).toBe(0);
  });

  it('keeps at most 20 events from one batch', async () => {
    const user = await makeUser();
    const events = Array.from({ length: 25 }, () => ({ name: 'screen-view', screen: '/activity' }));
    await post(user, { events }).expect(204);
    expect(await rows().countDocuments()).toBe(20);
  });

  it('derives podKind on the server and keeps a podId only for a chat or team pod the person can see', async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const team = await Pod.create({ name: 'Team', type: 'team', createdBy: user._id, members: [user._id] });
    const room = await Pod.create({ name: 'Room', type: 'agent-room', createdBy: user._id, members: [user._id] });
    const theirs = await Pod.create({ name: 'Theirs', type: 'chat', createdBy: stranger._id, members: [stranger._id] });
    await post(user, { events: [
      { name: 'invite-copy', screen: '/pods/:podId', podId: String(team._id), podKind: 'agent-dm', props: { via: 'link' } },
      { name: 'reaction-add', screen: '/pods/:podId', podId: String(room._id), props: { kind: 'up' } },
      { name: 'screen-view', screen: '/pods/:podId', podId: String(theirs._id), podKind: 'team' },
    ] }).expect(204);
    const stored = await rows().find().sort({ _id: 1 }).toArray();
    expect(stored[0]).toMatchObject({ podKind: 'team', props: { via: 'link' } });
    expect(String(stored[0].podId)).toBe(String(team._id));
    // Inside a DM with an agent: name, screen and kind only.
    expect(stored[1].podKind).toBe('agent-room');
    expect(stored[1].podId).toBeUndefined();
    expect(stored[1].props).toBeUndefined();
    // Not a member: nothing about the pod, and the forged kind is ignored.
    expect(stored[2].podKind).toBeUndefined();
    expect(stored[2].podId).toBeUndefined();
  });

  it('keeps no podId for an admin who can view a pod but is not in it', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser();
    const pod = await Pod.create({ name: 'Theirs', type: 'team', createdBy: owner._id, members: [owner._id] });
    await post(admin, { name: 'screen-view', screen: '/pods/:podId', podId: String(pod._id) }).expect(204);
    const [row] = await rows().find().toArray();
    expect(row.podKind).toBe('team');
    expect(row.podId).toBeUndefined();
  });

  it('records nothing for an EU, EEA or UK account until the person turns it on', async () => {
    const user = await makeUser();
    for (const country of ['DE', 'NO', 'GB']) {
      // eslint-disable-next-line no-await-in-loop
      await post(user, { name: 'app-open', screen: '/' }, { 'cf-ipcountry': country }).expect(204);
    }
    expect(await rows().countDocuments()).toBe(0);
    expect((await setting(user, { 'cf-ipcountry': 'FR' })).body).toEqual({ usageEvents: false, chosen: false, browserSignal: false });
    await choose(user, true).expect(200);
    await post(user, { name: 'app-open', screen: '/' }, { 'cf-ipcountry': 'DE' }).expect(204);
    expect(await rows().countDocuments()).toBe(1);
  });

  it('treats a request with no country, or an unknown one, as opt-in', async () => {
    const user = await makeUser();
    await post(user, { name: 'app-open', screen: '/' }, { 'cf-ipcountry': 'XX' }).expect(204);
    await request(app).post('/api/stats/ui-event').set('Authorization', `Bearer ${issueSessionToken(user)}`)
      .send({ name: 'app-open', screen: '/' }).expect(204);
    expect(await rows().countDocuments()).toBe(0);
  });

  it('records by default elsewhere, and the switch turns it off', async () => {
    const user = await makeUser();
    expect((await setting(user, { 'cf-ipcountry': 'US' })).body).toEqual({ usageEvents: true, chosen: false, browserSignal: false });
    await post(user, { name: 'app-open', screen: '/' }).expect(204);
    expect(await rows().countDocuments()).toBe(1);
    const off = await choose(user, false);
    expect(off.body).toMatchObject({ usageEvents: false, chosen: true });
    await post(user, { name: 'app-open', screen: '/' }).expect(204);
    expect(await rows().countDocuments()).toBe(1);
  });

  it('honours DNT and Sec-GPC on both endpoints, even for someone who turned it on', async () => {
    const user = await makeUser();
    await choose(user, true).expect(200);
    await post(user, { name: 'app-open', screen: '/' }, { dnt: '1' }).expect(204);
    await post(user, { name: 'app-open', screen: '/' }, { 'sec-gpc': '1' }).expect(204);
    expect(await rows().countDocuments()).toBe(0);
    await hit({ name: 'page-view', page: '/' }, { dnt: '1' }).expect(204);
    await hit({ name: 'page-view', page: '/' }, { 'sec-gpc': '1' }).expect(204);
    expect(await counts().countDocuments()).toBe(0);
    expect((await setting(user, { 'sec-gpc': '1' })).body.browserSignal).toBe(true);
  });

  it('rejects a switch value that is not a boolean', async () => {
    const user = await makeUser();
    await choose(user, 'yes').expect(400);
    expect((await User.findById(user._id).lean()).preferences?.usageEvents).toBeUndefined();
  });

  it('stores nothing for a bot account', async () => {
    const bot = await makeUser({ isBot: true, botMetadata: { agentName: 'scout' } });
    await post(bot, { name: 'app-open', screen: '/' });
    expect(await rows().countDocuments()).toBe(0);
  });

  it('flags internal accounts from deploy config and admins, without dropping them', async () => {
    process.env.USAGE_INTERNAL_USERNAMES = 'ops-person';
    try {
      const ops = await makeUser({ username: 'ops-person' });
      const admin = await makeUser({ role: 'admin' });
      await post(ops, { name: 'app-open', screen: '/' }).expect(204);
      await post(admin, { name: 'app-open', screen: '/' }).expect(204);
      expect(await rows().countDocuments({ isInternal: true })).toBe(2);
    } finally {
      delete process.env.USAGE_INTERNAL_USERNAMES;
    }
  });

  // F401: test and seat accounts are many and made on the fly, so the deploy
  // names them by prefix too. A prefix matches the start of a username only.
  it('flags accounts whose username starts with a configured prefix', async () => {
    process.env.USAGE_INTERNAL_PREFIXES = ' Walk- , ,seat-';
    try {
      const walker = await makeUser({ username: 'walk-1107' });
      const seat = await makeUser({ username: 'SEAT-nova' });
      const person = await makeUser({ username: 'sidewalk-fan' });
      await post(walker, { name: 'app-open', screen: '/' }).expect(204);
      await post(seat, { name: 'app-open', screen: '/' }).expect(204);
      await post(person, { name: 'app-open', screen: '/' }).expect(204);
      expect(await rows().countDocuments({ isInternal: true })).toBe(2);
      expect(await rows().countDocuments({ isInternal: false })).toBe(1);
    } finally {
      delete process.env.USAGE_INTERNAL_PREFIXES;
    }
  });

  it('ignores a prefix shorter than 4 characters, so a slip cannot flag real people', async () => {
    process.env.USAGE_INTERNAL_PREFIXES = 'a, walk-';
    try {
      const { internalPrefixes } = require('../../services/usageEvents');
      expect(internalPrefixes()).toEqual({ prefixes: ['walk-'], ignored: 1 });
      const person = await makeUser({ username: 'alice' });
      const walker = await makeUser({ username: 'walk-1110' });
      await post(person, { name: 'app-open', screen: '/' }).expect(204);
      await post(walker, { name: 'app-open', screen: '/' }).expect(204);
      expect(await rows().countDocuments({ isInternal: true })).toBe(1);
      expect(await rows().countDocuments({ isInternal: false })).toBe(1);
    } finally {
      delete process.env.USAGE_INTERNAL_PREFIXES;
    }
  });

  it('caps a person at the daily limit', async () => {
    const user = await makeUser();
    await rows().insertMany(Array.from({ length: DAILY_CAP - 1 }, () => ({ userId: user._id, name: 'screen-view', at: new Date() })));
    await post(user, { events: [1, 2, 3].map(() => ({ name: 'screen-view', screen: '/activity' })) }).expect(204);
    expect(await rows().countDocuments({ userId: user._id })).toBe(DAILY_CAP);
  });

  it('counts logged-out hits per day, page, ref and value, and nothing per visitor', async () => {
    const res = await hit({ name: 'page-view', page: '/guides/nope-not-a-guide/', ref: 'x' });
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    await hit({ name: 'page-view', page: '/', ref: 'ME-personal-code' }).expect(204);
    await hit({ name: 'page-view', page: '/' }).expect(204);
    await hit({ name: 'page-view', page: '/' }).expect(204);
    await hit({ name: 'invite-page-view', page: '/invite/abc123secret' }).expect(204);
    await hit({ name: 'cta-click', page: '/', value: 'hero-start' }).expect(204);
    await hit({ name: 'auth-choice', page: '/register', value: 'carrier-pigeon' }).expect(204);
    const all = await counts().find().toArray();
    const by = (q) => all.filter((row) => Object.entries(q).every(([k, v]) => row[k] === v));
    expect(by({ name: 'page-view', page: 'other', refTag: 'x' })[0].n).toBe(1);
    expect(by({ name: 'page-view', page: '/', refTag: 'other' })[0].n).toBe(1);
    expect(by({ name: 'page-view', page: '/', refTag: 'none' })[0].n).toBe(2);
    expect(by({ name: 'invite-page-view' })[0].page).toBe('/invite/:token');
    expect(by({ name: 'cta-click' })[0].value).toBe('hero-start');
    expect(by({ name: 'auth-choice' })[0].value).toBeUndefined();
    expect(JSON.stringify(all)).not.toMatch(/abc123secret|ME-personal-code|nope-not-a-guide|carrier-pigeon/);
    for (const row of all) expect(Object.keys(row).sort()).toEqual(expect.arrayContaining(['day', 'dayStart', 'n', 'name', 'page', 'refTag']));
  });

  it('counts a published guide by its own path', async () => {
    const pages = require('../../config/publicPages.json');
    const guide = pages.find((page) => page.startsWith('/guides/') && page !== '/guides/');
    await hit({ name: 'page-view', page: guide.replace(/\/$/, '') }).expect(204);
    expect((await counts().findOne()).page).toBe(guide);
  });

  it('answers an unknown logged-out name with a 400 that never echoes it', async () => {
    const res = await hit({ name: 'secret-thing', page: '/' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secret-thing');
  });

  it('expires events after 90 days and page counts after 13 months', async () => {
    const user = await makeUser();
    await post(user, { name: 'app-open', screen: '/' }).expect(204);
    await hit({ name: 'page-view', page: '/' }).expect(204);
    const ttl = async (name) => (await mongoose.connection.db.collection(name).indexes())
      .find((index) => index.expireAfterSeconds !== undefined);
    expect(await ttl('ui_events')).toMatchObject({ key: { at: 1 }, expireAfterSeconds: 90 * 24 * 3600 });
    expect(await ttl('ui_daily_counts')).toMatchObject({ key: { dayStart: 1 }, expireAfterSeconds: 396 * 24 * 3600 });
  });
});
