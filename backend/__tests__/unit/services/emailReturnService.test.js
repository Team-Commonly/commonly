// F519: do our emails bring people back? A link's ?em=<kind>.<send id> names
// no one; the send row is written once the provider accepted the email, the
// first signed-in visit with the tag marks it returned for the recipient only,
// and the count joins returns to the person's own posts within 24h.
jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return { pool: new Pool() };
});

const fs = require('fs');
const path = require('path');
const { pool } = require('../../../config/db-pg');
const emailReturns = require('../../../services/emailReturnService');

const HOUR = 60 * 60 * 1000;
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0013_email_sends.sql'), 'utf8');
// Only the columns the count reads; the real table is schema.sql's.
const MESSAGES = `CREATE TABLE messages (
  id SERIAL PRIMARY KEY, pod_id VARCHAR(24), user_id VARCHAR(24) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;

const U1 = 'a'.repeat(24);
const U2 = 'b'.repeat(24);
const POD = 'c'.repeat(24);
const OTHER_POD = 'd'.repeat(24);
const T0 = new Date('2026-11-15T08:00:00Z');

const post = (userId, podId, at) => pool.query(
  'INSERT INTO messages (pod_id, user_id, created_at) VALUES ($1, $2, $3)', [podId, userId, at],
);

beforeAll(async () => { await pool.query(MIGRATION); await pool.query(MESSAGES); });
afterEach(() => pool.query('DELETE FROM email_sends; DELETE FROM messages;'));

describe('the tag', () => {
  it('is random per send, names no one, and round-trips', () => {
    const a = emailReturns.newSendId();
    expect(a).toMatch(/^[a-f0-9]{24}$/);
    expect(emailReturns.newSendId()).not.toBe(a);
    expect(emailReturns.parseTag(emailReturns.tagFor('mention', a))).toEqual({ kind: 'mention', sendId: a });
  });

  it('refuses anything but a known kind and a 24-hex id', () => {
    ['mention.xyz', 'stall.' + 'a'.repeat(24), 'digest.' + 'A'.repeat(24), 'digest.' + 'a'.repeat(25), null, 7]
      .forEach((raw) => expect(emailReturns.parseTag(raw)).toBeNull());
  });

  it('joins an existing query and keeps the fragment', () => {
    const id = 'e'.repeat(24);
    expect(emailReturns.tagUrl('https://x.test/v2', 'digest', id)).toBe(`https://x.test/v2?em=digest.${id}`);
    expect(emailReturns.tagUrl('https://x.test/v2/activity?item=1#top', 'needs-you', id))
      .toBe(`https://x.test/v2/activity?item=1&em=needs-you.${id}#top`);
  });
});

describe('returns', () => {
  it('records the first return by the recipient only', async () => {
    const sendId = emailReturns.newSendId();
    await emailReturns.noteSend({ sendId, kind: 'mention', recipientUserId: U1, podId: POD, sentAt: T0 });
    const tag = emailReturns.tagFor('mention', sendId);

    expect(await emailReturns.recordEmailReturn(U2, tag)).toBe(false);
    expect(await emailReturns.recordEmailReturn(U1, `digest.${sendId}`)).toBe(false);
    expect(await emailReturns.recordEmailReturn(U1, tag, new Date(T0.getTime() + HOUR))).toBe(true);
    expect(await emailReturns.recordEmailReturn(U1, tag, new Date(T0.getTime() + 2 * HOUR))).toBe(false);

    const { rows } = await pool.query('SELECT returned_at FROM email_sends WHERE send_id = $1', [sendId]);
    expect(new Date(rows[0].returned_at).getTime()).toBe(T0.getTime() + HOUR);
  });

  it('records nothing for a tag no email carried', async () => {
    expect(await emailReturns.recordEmailReturn(U1, `mention.${'f'.repeat(24)}`)).toBe(false);
  });
});

describe('counts per kind', () => {
  const send = async (kind, recipient, podId, returnedAfterMs) => {
    const sendId = emailReturns.newSendId();
    await emailReturns.noteSend({ sendId, kind, recipientUserId: recipient, podId, sentAt: T0 });
    if (returnedAfterMs !== undefined) {
      await emailReturns.recordEmailReturn(recipient, emailReturns.tagFor(kind, sendId), new Date(T0.getTime() + returnedAfterMs));
    }
  };

  it('counts sent, returned, and posted within 24h in the email pod (any pod for the digest)', async () => {
    await send('mention', U1, POD, HOUR); // back, posts in the pod 2h later
    await send('mention', U2, POD, HOUR); // back, posts only in another pod
    await send('mention', U2, POD); // never back
    await send('digest', U1, null, HOUR); // back; U1's post in POD counts for the digest
    await send('needs-you', U2, POD, HOUR); // back, posts 30h later: outside 24h
    await post(U1, POD, new Date(T0.getTime() + 3 * HOUR));
    await post(U2, OTHER_POD, new Date(T0.getTime() + 2 * HOUR));
    await post(U2, POD, new Date(T0.getTime() + 31 * HOUR));

    expect(await emailReturns.emailReturnCounts(new Date(T0.getTime() - HOUR))).toEqual([
      { kind: 'digest', sent: 1, returned: 1, posted24h: 1 },
      { kind: 'mention', sent: 3, returned: 2, posted24h: 1 },
      { kind: 'needs-you', sent: 1, returned: 1, posted24h: 0 },
    ]);
  });

  it('does not count a post from before the return', async () => {
    await send('mention', U1, POD, 2 * HOUR);
    await post(U1, POD, new Date(T0.getTime() + HOUR));
    expect(await emailReturns.emailReturnCounts(new Date(T0.getTime() - HOUR)))
      .toEqual([{ kind: 'mention', sent: 1, returned: 1, posted24h: 0 }]);
  });

  it('leaves out sends before the window', async () => {
    await send('digest', U1, null);
    expect(await emailReturns.emailReturnCounts(new Date(T0.getTime() + HOUR))).toEqual([]);
  });
});

describe('a failed record', () => {
  it('never throws out of noteSend, so a delivered email stays delivered', async () => {
    jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('pg down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(emailReturns.noteSend({ sendId: 'e'.repeat(24), kind: 'digest', recipientUserId: U1 }))
      .resolves.toBeUndefined();
  });
});
