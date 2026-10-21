/**
 * internalAccountExclusion, EXECUTED against a real Mongo (mongodb-memory-server).
 *
 * The onboarding-silence alert pages a person about an outside newcomer who
 * typed and got no reply. On 2026-10-16 it paged twice about growth-ops, our own
 * operator account. The exclusion is a Mongo filter, so only a real query shows
 * which rows it keeps; a mock would only show the filter's shape.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const {
  HUMAN_FILTER, internalAccountExclusion, parseInternalAccounts,
} = require('../../../services/userClassification');

let mongod;
let users;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  users = mongoose.connection.db.collection('users_internal_test');
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

beforeEach(async () => {
  await users.deleteMany({});
  await users.insertMany([
    { username: 'outside-person', email: 'person@gmail.com', role: 'user' },
    { username: 'another-person', email: 'someone@fluxr.com', role: 'user' },
    { username: 'growth-ops', email: 'growth@ops.commonly.invalid', role: 'user' },
    { username: 'qa-walk-1', email: 'qa1@example.com', role: 'user' },
    { username: 'fixture', email: 'x@sub.example.org', role: 'user' },
    { username: 'local-test', email: 'x@box.test', role: 'user' },
    { username: 'the-admin', email: 'admin@gmail.com', role: 'admin' },
    { username: 'Lily-Shen', email: 'lily@gmail.com', role: 'user' },
    { username: 'eng-smoke-abc', email: 'smoke@gmail.com', role: 'user' },
    { username: 'staff-person', email: 'me@commonly.me', role: 'user' },
    { username: 'scout', isBot: true, email: 'scout@agents.commonly.local' },
    // Look-alikes that must stay outside people.
    { username: 'invalidator', email: 'x@invalidator.io', role: 'user' },
    { username: 'example-fan', email: 'fan@notexample.com', role: 'user' },
    { username: 'lily-shen-fan', email: 'fan@gmail.com', role: 'user' },
  ]);
});

const outsidePeople = async (env) => (await users
  .find({ ...HUMAN_FILTER, ...internalAccountExclusion(env) })
  .project({ username: 1 }).toArray()).map((row) => row.username).sort();

describe('internal accounts are not outside newcomers', () => {
  test('built in: admins and reserved email domains are internal; everyone else is a person', async () => {
    expect(await outsidePeople({})).toEqual([
      'Lily-Shen', 'another-person', 'eng-smoke-abc', 'example-fan', 'invalidator',
      'lily-shen-fan', 'outside-person', 'staff-person',
    ]);
  });

  test('INTERNAL_ACCOUNTS adds usernames (any case), prefix* and @domain entries', async () => {
    expect(await outsidePeople({ INTERNAL_ACCOUNTS: ' lily-shen , eng-smoke-* , @commonly.me ' })).toEqual([
      'another-person', 'example-fan', 'invalidator', 'lily-shen-fan', 'outside-person',
    ]);
  });

  test('a username entry matches the whole name only, and regex characters in it are literal', async () => {
    await users.insertOne({ username: 'a.b', email: 'ab@gmail.com', role: 'user' });
    await users.insertOne({ username: 'axb', email: 'axb@gmail.com', role: 'user' });
    const kept = await outsidePeople({ INTERNAL_ACCOUNTS: 'a.b,lily' });
    expect(kept).toContain('axb');
    expect(kept).not.toContain('a.b');
    expect(kept).toContain('Lily-Shen');
  });

  test('parses entries, ignoring empty ones and a bare * or @', () => {
    expect(parseInternalAccounts('Sam, qa-*, @Example.IO, , *, @')).toEqual({
      usernames: ['sam'], prefixes: ['qa-'], domains: ['example.io'],
    });
    expect(parseInternalAccounts(undefined)).toEqual({ usernames: [], prefixes: [], domains: [] });
  });
});
