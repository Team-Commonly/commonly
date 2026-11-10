const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const { buildUsageReport, formatUsageReport } = require('../../scripts/usage-report');

// F403: the daily usage read Growth runs on ops-runner. Per-day counts by
// event and by screen or step, from the F399 events. Our own accounts are left
// out (the isInternal stamp, admins, the username list and the prefix list),
// and nothing it returns or prints carries an id, a username or typed text.
describe('usage report', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const day = (iso) => new Date(`${iso}T09:00:00Z`);
  let db;
  let people;

  const user = (username, extra = {}) => ({
    _id: new mongoose.Types.ObjectId(), username, email: `${username}@report.test`, ...extra,
  });
  const event = (who, name, at, extra = {}) => ({
    userId: who._id, name, screen: '/', at, isInternal: false, ...extra,
  });

  beforeAll(async () => {
    await setupMongoDb();
    db = mongoose.connection.db;
  });

  beforeEach(async () => {
    await clearMongoDb();
    // Raw collections with no model: clearMongoDb may not reach them.
    await Promise.all(['users', 'ui_events', 'ui_daily_counts'].map((name) => db.collection(name).deleteMany({})));
    people = {
      ana: user('ana'),
      ben: user('Ben'),
      admin: user('boss', { role: 'admin' }),
      listed: user('Ops-Person'),
      walker: user('WALK-1107'),
      stamped: user('stamped'),
      // Seen in the window only under a string id, so only the id's string form can find them.
      stringOnly: user('seat-strs'),
    };
    await db.collection('users').insertMany(Object.values(people));
    await db.collection('ui_events').insertMany([
      event(people.ana, 'app-open', day('2026-11-09')),
      event(people.ana, 'app-open', day('2026-11-09')),
      event(people.ben, 'app-open', day('2026-11-09')),
      event(people.ana, 'welcome-start-click', day('2026-11-09'), { props: { start: 'byo' } }),
      event(people.ben, 'welcome-start-click', day('2026-11-09'), { props: { start: 'hosted' } }),
      event(people.ben, 'screen-view', day('2026-11-10'), { screen: '/pods/:podId/board' }),
      // Our own accounts, each left out by a different rule.
      event(people.admin, 'app-open', day('2026-11-09')),
      event(people.listed, 'app-open', day('2026-11-09')),
      event(people.walker, 'app-open', day('2026-11-09')),
      event(people.stamped, 'app-open', day('2026-11-09'), { isInternal: true }),
      // A string id, which the writer never stores, still resolves to its account.
      event(people.admin, 'app-open', day('2026-11-09'), { userId: String(people.admin._id) }),
      { userId: String(people.stringOnly._id), name: 'app-open', screen: '/', at: day('2026-11-09'), isInternal: false },
      // A row with no person adds events but no people.
      { name: 'app-open', screen: '/', at: day('2026-11-09'), isInternal: false },
      // Outside the window.
      event(people.ana, 'app-open', day('2026-10-01')),
    ]);
    await db.collection('ui_daily_counts').insertMany([
      { _id: '2026-11-09|page-view|/|x|', day: '2026-11-09', dayStart: day('2026-11-09'), name: 'page-view', page: '/', refTag: 'x', n: 7 },
      { _id: '2026-11-09|cta-click|/|none|pricing', day: '2026-11-09', dayStart: day('2026-11-09'), name: 'cta-click', page: '/', refTag: 'none', value: 'pricing', n: 2 },
      { _id: '2026-10-01|page-view|/|none|', day: '2026-10-01', dayStart: day('2026-10-01'), name: 'page-view', page: '/', refTag: 'none', n: 99 },
    ]);
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const build = (opts = {}) => buildUsageReport(db, {
    days: 7, now, usernames: 'ops-person', prefixes: 'walk-,seat-', ...opts,
  });

  it('counts events and people per day, by event and by screen or step, without our own accounts', async () => {
    const report = await build();
    const row = (dayIso, name, extra = {}) => report.signedIn.find((r) => r.day === dayIso && r.name === name
      && Object.entries(extra).every(([k, v]) => r[k] === v));
    expect(row('2026-11-09', 'app-open')).toMatchObject({ screen: '/', step: '', events: 4, people: 2 });
    expect(row('2026-11-09', 'welcome-start-click', { step: 'start=byo' })).toMatchObject({ events: 1, people: 1 });
    expect(row('2026-11-09', 'welcome-start-click', { step: 'start=hosted' })).toMatchObject({ events: 1, people: 1 });
    expect(row('2026-11-10', 'screen-view')).toMatchObject({ screen: '/pods/:podId/board', events: 1, people: 1 });
    expect(report.activePeople).toEqual([{ day: '2026-11-10', people: 1 }, { day: '2026-11-09', people: 2 }]);
    // The admin (twice, once by a string id), the listed name, both prefixes and the stamp.
    expect(report.excludedInternalEvents).toBe(6);
    expect(report.signedIn.some((r) => r.day === '2026-10-01')).toBe(false);
  });

  it('counts logged-out hits per day by page, ref and value, inside the window only', async () => {
    const report = await build();
    expect(report.loggedOut).toEqual([
      { day: '2026-11-09', name: 'cta-click', page: '/', ref: 'none', value: 'pricing', hits: 2 },
      { day: '2026-11-09', name: 'page-view', page: '/', ref: 'x', value: '', hits: 7 },
    ]);
  });

  it('ignores a prefix shorter than 4 characters, so a slip cannot drop real people', async () => {
    const report = await build({ prefixes: 'a, walk-, seat-' });
    expect(report.ignoredShortPrefixes).toBe(1);
    expect(report.signedIn.find((r) => r.day === '2026-11-09' && r.name === 'app-open')).toMatchObject({ events: 4, people: 2 });
  });

  it('says how many internal names and prefixes it used, and warns when it has none', async () => {
    const report = await build();
    expect(report.internalLists).toEqual({ usernames: 1, prefixes: 2 });
    expect(formatUsageReport(report)).toContain('Internal lists: 1 usernames, 2 prefixes.');
    expect(formatUsageReport(report)).not.toContain('Warning: both internal lists are empty');

    const bare = await build({ usernames: '', prefixes: '' });
    expect(bare.internalLists).toEqual({ usernames: 0, prefixes: 0 });
    expect(formatUsageReport(bare)).toContain('Warning: both internal lists are empty');

    // Counted after the 4-character floor; a list of only short prefixes is not
    // an empty environment, so it gets the ignored line, not the warning.
    expect((await build({ prefixes: 'a, walk-, seat-' })).internalLists.prefixes).toBe(2);
    const short = await build({ usernames: '', prefixes: 'a' });
    expect(formatUsageReport(short)).toContain('Ignored 1 internal prefix(es)');
    expect(formatUsageReport(short)).not.toContain('Warning: both internal lists are empty');
  });

  it('reads a prefix literally, not as a pattern', async () => {
    // 'wal.' as a pattern would match 'walk-1107'; as text it matches nothing.
    const report = await build({ prefixes: 'wal., seat-' });
    expect(report.signedIn.find((r) => r.day === '2026-11-09' && r.name === 'app-open')).toMatchObject({ events: 5, people: 3 });
  });

  it('carries no id, username or email in what it returns or prints', async () => {
    const report = await build();
    const text = JSON.stringify(report) + formatUsageReport(report);
    for (const person of Object.values(people)) {
      expect(text).not.toContain(String(person._id));
      expect(text.toLowerCase()).not.toContain(`${person.username.toLowerCase()}@`);
    }
    for (const name of ['ana', 'Ben', 'boss', 'Ops-Person', 'WALK-1107', 'stamped', 'seat-strs']) {
      expect(text).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('bounds the window to 1-90 days', async () => {
    expect((await build({ days: 0 })).days).toBe(1);
    expect((await build({ days: 500 })).days).toBe(90);
    expect((await build({ days: 'x' })).days).toBe(7);
  });
});
