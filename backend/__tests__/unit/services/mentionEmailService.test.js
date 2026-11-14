// F512: a teammate's @mention waited for the next digest. Since #2559 every
// kind 'mention' row skips the needs-you email, which was right for agent
// mentions (their real asks email as decision, approval, blocked or handoff)
// and wrong for a person asking a person. Ruling (Cofounder, 11-14): one email
// if the person mentioned hasn't opened that pod about 15 minutes later; never
// to the author; one per recipient per pod per 6h, later mentions ride the
// digest; the digest opt-out applies.
const mockSendEmail = jest.fn();
jest.mock('../../../services/emailService', () => ({ sendEmail: mockSendEmail }));
// The visit and window stores are Postgres tables (ADR-034 D4), built from the
// shipped migration on pg-mem.
jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return { pool: new Pool() };
});

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const AttentionItem = require('../../../models/AttentionItem');
const { recordMentionedUsers } = require('../../../services/attentionItemService');
const mentionEmail = require('../../../services/mentionEmailService');

const MIN = 60000;
const HOUR = 60 * MIN;
const originalEnv = process.env;
let serial = 0;

const fs = require('fs');
const path = require('path');
const { pool } = require('../../../config/db-pg');

const MIGRATION = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0012_mention_email.sql'), 'utf8');
const resetPg = () => pool.query('DELETE FROM pod_visits; DELETE FROM mention_email_state;');

beforeAll(async () => { await setupMongoDb(); await pool.query(MIGRATION); });
afterAll(closeMongoDb);
beforeEach(() => {
  process.env = { ...originalEnv, SMTP2GO_API_KEY: 'smtp-key', SMTP2GO_FROM_EMAIL: 'hello@commonly.me' };
  mockSendEmail.mockReset().mockResolvedValue({ data: { data: { succeeded: 1, failed: 0, failures: [] } } });
});
const clearAll = async () => { await clearMongoDb(); await resetPg(); };
afterEach(async () => { process.env = originalEnv; jest.restoreAllMocks(); await clearAll(); });

const person = (username, extra = {}) => {
  serial += 1;
  return User.create({
    username, email: `${username}-${serial}@example.com`, password: 'Password123!', verified: true, ...extra,
  });
};
const mongoose = require('mongoose');

const visitCount = async (userId) => Number((await pool.query(
  userId ? 'SELECT COUNT(*) AS n FROM pod_visits WHERE user_id = $1' : 'SELECT COUNT(*) AS n FROM pod_visits',
  userId ? [String(userId)] : [],
)).rows[0].n);
// The pass mails nothing older than the first visit stamp (rollout floor), so
// each test starts as if F512 had been live for a day.
const rolledOut = (hoursAgo = 30) => pool.query(
  'INSERT INTO pod_visits (user_id, pod_id, created_at) VALUES ($1, $2, $3)',
  [String(new mongoose.Types.ObjectId()), String(new mongoose.Types.ObjectId()), new Date(Date.now() - hoursAgo * HOUR)],
);
const room = async (name, members) => {
  if (!(await visitCount())) await rolledOut();
  return Pod.create({ name, createdBy: members[0]._id, members: members.map((m) => m._id) });
};

// What a chat write does: the message lands, then the writer records its mentions.
const mention = async (author, pod, content, at) => {
  serial += 1;
  await recordMentionedUsers({ _id: 1000 + serial, podId: pod._id, userId: author._id, content, createdAt: at });
  const row = await AttentionItem.findOne({ messageId: String(1000 + serial) }).lean();
  // createdAt is immutable through Mongoose; backdate it on the collection.
  if (row) await AttentionItem.collection.updateOne({ _id: row._id }, { $set: { createdAt: at } });
  return row;
};
const sweep = (now) => mentionEmail.sweepMentionEmails({ now });
const recipients = () => mockSendEmail.mock.calls.map(([mail]) => mail.to);

const team = async () => {
  const ana = await person('ana');
  const bo = await person('bo');
  const pod = await room('Launch', [ana, bo]);
  return { ana, bo, pod };
};

test('a mention the person has not looked at in 15 minutes sends them one email, and none to the author', async () => {
  const { ana, bo, pod } = await team();
  const at = new Date(Date.now() - 16 * MIN);
  await mention(ana, pod, '@bo can you check the launch copy?', at);
  const r = await sweep(new Date());
  expect(r.sent).toBe(1);
  expect(recipients()).toEqual([bo.email]);
  const mail = mockSendEmail.mock.calls[0][0];
  expect(mail.subject).toBe('ana mentioned you in Launch');
  expect(mail.textBody).toContain(`/v2/pods/${pod._id}`);
  expect(mail.textBody).toContain('/api/email/unsubscribe/');
  // Pod text can be private; the email names who and where, not what.
  expect(mail.textBody).not.toContain('launch copy');
  expect(mail.htmlBody).not.toContain('launch copy');
  // The next pass finds nothing new.
  expect((await sweep(new Date())).sent).toBe(0);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
});

// CodeRabbit (#4135): a platform-authored row is stored under an account
// that did not write it, so its @handle must not become that account's
// mention. Both stores mark it kernel: author_kind on PG, authorKind on Mongo.
test('a platform-authored row creates no mention and no email', async () => {
  const { ana, pod } = await team();
  const at = new Date(Date.now() - 16 * MIN);
  await recordMentionedUsers({ _id: 9001, podId: pod._id, userId: ana._id, content: '@bo welcome', author_kind: 'kernel', createdAt: at });
  await recordMentionedUsers({ _id: 9002, podId: pod._id, userId: ana._id, content: '@bo welcome', authorKind: 'kernel', createdAt: at });
  expect(await AttentionItem.countDocuments({ kind: 'mention' })).toBe(0);
  expect((await sweep(new Date())).sent).toBe(0);
});

test('before 15 minutes nothing goes; the pass after the mark sends it', async () => {
  const { ana, pod } = await team();
  const at = new Date(Date.now() - 5 * MIN);
  await mention(ana, pod, '@bo ping', at);
  expect((await sweep(new Date())).sent).toBe(0);
  expect((await sweep(new Date(at.getTime() + 16 * MIN))).sent).toBe(1);
});

test('opening the pod after the mention, or having it open already, means no email', async () => {
  const { ana, bo, pod } = await team();
  const at = new Date(Date.now() - 20 * MIN);
  await mention(ana, pod, '@bo ping', at);
  await mentionEmail.stampPodOpened(bo._id, pod._id, new Date(at.getTime() + 3 * MIN));
  expect((await sweep(new Date())).sent).toBe(0);

  await clearAll();
  const t = await team();
  // In the room since before the mention and never left: it showed up live.
  await mentionEmail.stampPodOpened(t.bo._id, t.pod._id, new Date(Date.now() - 2 * HOUR));
  await mention(t.ana, t.pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  expect((await sweep(new Date())).sent).toBe(0);

  await clearAll();
  const u = await team();
  // Opened before, closed before: they have not seen this one.
  await mentionEmail.stampPodOpened(u.bo._id, u.pod._id, new Date(Date.now() - 3 * HOUR));
  await mentionEmail.stampPodClosed(u.bo._id, [u.pod._id], new Date(Date.now() - 2 * HOUR));
  await mention(u.ana, u.pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  expect((await sweep(new Date())).sent).toBe(1);
});

test('a room opened and never closed long ago does not suppress forever', async () => {
  const { ana, bo, pod } = await team();
  // A process that died never stamped the close.
  await mentionEmail.stampPodOpened(bo._id, pod._id, new Date(Date.now() - 30 * HOUR));
  await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  expect((await sweep(new Date())).sent).toBe(1);
});

test("an agent's mention sends nothing", async () => {
  const ana = await person('ana');
  const bot = await person('helper-bot', { isBot: true });
  const bo = await person('bo');
  const pod = await room('Launch', [ana, bot, bo]);
  await mention(bot, pod, '@bo the build is green', new Date(Date.now() - 20 * MIN));
  expect(await AttentionItem.countDocuments({ kind: 'mention' })).toBe(1);
  expect((await sweep(new Date())).sent).toBe(0);
  expect(mockSendEmail).not.toHaveBeenCalled();
});

test('one email per recipient per pod per 6 hours; another pod is its own window', async () => {
  const { ana, bo, pod } = await team();
  const other = await room('Ops', [ana, bo]);
  const t0 = Date.now() - 7 * HOUR;
  await mention(ana, pod, '@bo first', new Date(t0));
  expect((await sweep(new Date(t0 + 16 * MIN))).sent).toBe(1);
  await mention(ana, pod, '@bo second', new Date(t0 + 30 * MIN));
  expect((await sweep(new Date(t0 + 46 * MIN))).sent).toBe(0);
  await mention(ana, other, '@bo over here', new Date(t0 + 30 * MIN));
  expect((await sweep(new Date(t0 + 47 * MIN))).sent).toBe(1);
  // The held one stays open for the digest.
  expect(await AttentionItem.countDocuments({ kind: 'mention', status: 'open' })).toBe(3);
  // Past 6h, a new mention emails again.
  await mention(ana, pod, '@bo third', new Date(t0 + 6 * HOUR + 10 * MIN));
  expect((await sweep(new Date(t0 + 6 * HOUR + 26 * MIN))).sent).toBe(1);
  expect(recipients()).toEqual([bo.email, bo.email, bo.email]);
});

test('the digest opt-out, an unverified address, or a reserved domain gets nothing', async () => {
  const ana = await person('ana');
  const off = await person('off', { emailPreferences: { dailyDigest: false, needsYou: true } });
  const unverified = await person('unv', { verified: false });
  const reserved = await person('res');
  await User.updateOne({ _id: reserved._id }, { $set: { email: 'res@example.invalid' } });
  const pod = await room('Launch', [ana, off, unverified, reserved]);
  await mention(ana, pod, '@off @unv @res ping', new Date(Date.now() - 20 * MIN));
  expect(await AttentionItem.countDocuments({ kind: 'mention' })).toBe(3);
  expect((await sweep(new Date())).sent).toBe(0);
  expect(mockSendEmail).not.toHaveBeenCalled();
});

test('a mention already answered or acknowledged, or from someone who left, sends nothing', async () => {
  const { ana, bo, pod } = await team();
  const row = await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  await AttentionItem.updateOne({ _id: row._id }, { $set: { status: 'resolved', resolvedBy: 'acknowledged' } });
  expect((await sweep(new Date())).sent).toBe(0);

  await mention(ana, pod, '@bo ping again', new Date(Date.now() - 20 * MIN));
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: bo._id } });
  expect((await sweep(new Date())).sent).toBe(0);
  expect(mockSendEmail).not.toHaveBeenCalled();
});

test('a failed send, or a 200 with the recipient failed, leaves the window for the next pass', async () => {
  const { ana, bo, pod } = await team();
  await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  mockSendEmail.mockRejectedValueOnce(new Error('smtp down'));
  expect((await sweep(new Date())).sent).toBe(0);
  mockSendEmail.mockResolvedValueOnce({ data: { data: { succeeded: 0, failed: 1, failures: ['rejected'] } } });
  expect((await sweep(new Date())).sent).toBe(0);
  expect((await sweep(new Date())).sent).toBe(1);
  expect(recipients()).toEqual([bo.email, bo.email, bo.email]);
});

test('two passes at once send one email', async () => {
  const { ana, pod } = await team();
  await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  const now = new Date();
  const [a, b] = await Promise.all([sweep(now), sweep(now)]);
  expect(a.sent + b.sent).toBe(1);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
});

test('a mention older than the catch-up window is left to the digest', async () => {
  const { ana, pod } = await team();
  // The first pass after deploy must not mail out the backlog.
  await mention(ana, pod, '@bo old news', new Date(Date.now() - 5 * HOUR));
  expect((await sweep(new Date())).sent).toBe(0);
});

test('a pod read stamps the open only when the read succeeded', async () => {
  const { EventEmitter } = require('events');
  const { bo, pod } = await team();
  await pool.query('DELETE FROM pod_visits WHERE user_id = $1', [String(bo._id)]);
  const read = async (statusCode) => {
    const res = Object.assign(new EventEmitter(), { statusCode });
    const next = jest.fn();
    mentionEmail.stampPodReadOnRequest({ userId: String(bo._id), params: { podId: String(pod._id) } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.emit('finish');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  };
  await read(403);
  expect(await visitCount(bo._id)).toBe(0);
  await read(200);
  expect(await visitCount(bo._id)).toBe(1);
});

// CodeRabbit (#4135): a read is one look, not an open session. No socket will
// ever close it, so it must not suppress a mention that comes after it.
test('a message read before the mention does not count as having the pod open', async () => {
  const { EventEmitter } = require('events');
  const { ana, bo, pod } = await team();
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  mentionEmail.stampPodReadOnRequest({ userId: String(bo._id), params: { podId: String(pod._id) } }, res, () => {});
  res.emit('finish');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  await mention(ana, pod, '@bo ping', new Date(Date.now() + 10 * MIN));
  expect((await sweep(new Date(Date.now() + 26 * MIN))).sent).toBe(1);
});

test('a read after the mention counts as seen', async () => {
  const { ana, bo, pod } = await team();
  const at = new Date(Date.now() - 20 * MIN);
  await mention(ana, pod, '@bo ping', at);
  await mentionEmail.stampPodRead(bo._id, pod._id, new Date(at.getTime() + MIN));
  expect((await sweep(new Date())).sent).toBe(0);
});

// CodeRabbit (#4135): a join stamped with its arrival time stays earlier than
// a leave that landed while the join was still being authorized.
test('a join whose leave landed during its authorization does not read as open', async () => {
  const { ana, bo, pod } = await team();
  const joinedAt = new Date(Date.now() - 2 * HOUR);
  await mentionEmail.stampPodClosed(bo._id, [pod._id], new Date(joinedAt.getTime() + 50));
  await mentionEmail.stampPodOpened(bo._id, pod._id, joinedAt);
  await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  expect((await sweep(new Date())).sent).toBe(1);
});

test('a backfilled row for an old mention is left to the digest, whatever its createdAt', async () => {
  const { ana, pod } = await team();
  const row = await mention(ana, pod, '@bo old', new Date(Date.now() - 20 * MIN));
  await AttentionItem.collection.updateOne({ _id: row._id }, { $set: { sourceCreatedAt: new Date(Date.now() - 3 * 24 * HOUR) } });
  expect((await sweep(new Date())).sent).toBe(0);
});

test('mentions from before the first visit stamp existed are not mailed', async () => {
  await resetPg();
  await rolledOut(0.25);
  const ana = await person('ana');
  const bo = await person('bo');
  const pod = await Pod.create({ name: 'Launch', createdBy: ana._id, members: [ana._id, bo._id] });
  await mention(ana, pod, '@bo read this already', new Date(Date.now() - 40 * MIN));
  expect((await sweep(new Date())).sent).toBe(0);
  await resetPg();
  expect((await sweep(new Date())).sent).toBe(0);
});

test('two mentions for the same person and pod in one pass send one email', async () => {
  const { ana, pod } = await team();
  await mention(ana, pod, '@bo one', new Date(Date.now() - 25 * MIN));
  await mention(ana, pod, '@bo two', new Date(Date.now() - 20 * MIN));
  const r = await sweep(new Date());
  expect(r.sent).toBe(1);
  expect(r.skipped).toBe(1);
});

test('a refused send after an earlier email gives back the earlier window, not a blank one', async () => {
  const { ana, bo, pod } = await team();
  const earlier = new Date(Date.now() - 7 * HOUR);
  await pool.query('INSERT INTO mention_email_state (recipient_user_id, pod_id, last_email_at) VALUES ($1, $2, $3)',
    [String(bo._id), String(pod._id), earlier]);
  await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  mockSendEmail.mockResolvedValueOnce({ data: { data: { succeeded: 0, failed: 1, failures: ['rejected'] } } });
  expect((await sweep(new Date())).sent).toBe(0);
  const state = (await pool.query('SELECT last_email_at FROM mention_email_state WHERE recipient_user_id = $1 AND pod_id = $2',
    [String(bo._id), String(pod._id)])).rows[0];
  expect(new Date(state.last_email_at).getTime()).toBe(earlier.getTime());
});

test('a timeout with no answer keeps the claim: no second email on the next pass', async () => {
  const { ana, pod } = await team();
  await mention(ana, pod, '@bo ping', new Date(Date.now() - 20 * MIN));
  mockSendEmail.mockRejectedValueOnce(Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true }));
  expect((await sweep(new Date())).failed).toBe(1);
  expect((await sweep(new Date())).sent).toBe(0);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
});
