// A member with no pod read point yet (everyone, the day #4150 ships) gets one
// seeded once from what we already hold, so their first return shows "New
// since your last visit". It never moves a real read point.
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PodReadPoint = require('../../../models/pg/PodReadPoint');
const { chooseSeed, seedPodReadPoint } = require('../../../services/podReadPointSeed');

// Seeds clamp to the real clock as well, so every seeded value is in the past.
const NOW = new Date('2026-11-16T12:00:00.000Z');
const at = (iso) => new Date(iso);

beforeAll(async () => {
  const ddl = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0014_pod_read_point.sql'), 'utf8');
  await mockPool.query(ddl);
  // Only the columns the seed reads; the real tables come from 0001 and 0011,
  // and the real-PG service test runs the seed against them.
  await mockPool.query(`
    CREATE TABLE messages (id SERIAL PRIMARY KEY, pod_id VARCHAR(24), user_id VARCHAR(24) NOT NULL,
      content TEXT NOT NULL, message_type VARCHAR(20) DEFAULT 'text' NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE thread_user_state (id SERIAL PRIMARY KEY, thread_root_id INTEGER NOT NULL,
      user_id VARCHAR(255) NOT NULL, pod_id VARCHAR(255) NOT NULL, last_read_at TIMESTAMPTZ);
  `);
});

const say = (pod, user, iso) => mockPool.query(
  'INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, $3, $4)', [pod, user, 'hi', iso],
);
const readThread = (pod, user, iso) => mockPool.query(
  'INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, last_read_at) VALUES (1, $1, $2, $3)', [user, pod, iso],
);

describe('chooseSeed', () => {
  it('takes the later of the thread read point and the last message, both of which show presence in this pod', () => {
    expect(chooseSeed({
      threadReadAt: at('2026-11-10T00:00:00Z'), lastMessageAt: at('2026-11-12T00:00:00Z'), lastActive: at('2026-11-15T00:00:00Z'),
    }, NOW)).toEqual(at('2026-11-12T00:00:00Z'));
    expect(chooseSeed({
      threadReadAt: at('2026-11-13T00:00:00Z'), lastMessageAt: at('2026-11-12T00:00:00Z'), lastActive: null,
    }, NOW)).toEqual(at('2026-11-13T00:00:00Z'));
  });

  it('falls back to last-active only with nothing from this pod', () => {
    expect(chooseSeed({ threadReadAt: null, lastMessageAt: null, lastActive: at('2026-11-15T00:00:00Z') }, NOW))
      .toEqual(at('2026-11-15T00:00:00Z'));
  });

  it('is nothing with no signal at all, so the pod opens at its end as before', () => {
    expect(chooseSeed({ threadReadAt: null, lastMessageAt: null, lastActive: null }, NOW)).toBeNull();
  });

  it('is never later than now', () => {
    expect(chooseSeed({ threadReadAt: null, lastMessageAt: at('2026-11-20T00:00:00Z'), lastActive: null }, NOW))
      .toEqual(NOW);
  });

  it('ignores a value that is not a date', () => {
    expect(chooseSeed({ threadReadAt: 'garbage', lastMessageAt: null, lastActive: undefined }, NOW)).toBeNull();
  });
});

describe('seedPodReadPoint', () => {
  it('seeds from the member\'s own activity in this pod', async () => {
    await say('pod-a', 'u1', '2026-11-12T08:00:00.000Z');
    await say('pod-a', 'u1', '2026-11-12T09:00:00.000Z');
    await say('pod-a', 'u2', '2026-11-14T09:00:00.000Z');
    await say('pod-z', 'u1', '2026-11-15T09:00:00.000Z');
    expect(await seedPodReadPoint({ podId: 'pod-a', userId: 'u1', now: NOW })).toBe('2026-11-12T09:00:00.000Z');
    expect(await PodReadPoint.get('pod-a', 'u1')).toBe('2026-11-12T09:00:00.000Z');
  });

  it('does not count a system line filed under the person, such as a task claim or a decline', async () => {
    await say('pod-s', 'u1', '2026-11-09T09:00:00.000Z');
    await mockPool.query(
      "INSERT INTO messages (pod_id, user_id, content, message_type, created_at) VALUES ('pod-s', 'u1', 'claimed', 'system', $1)",
      ['2026-11-12T09:00:00.000Z'],
    );
    expect(await seedPodReadPoint({ podId: 'pod-s', userId: 'u1', now: NOW })).toBe('2026-11-09T09:00:00.000Z');
  });

  it('reads the thread read point in this pod only', async () => {
    await readThread('pod-b', 'u1', '2026-11-13T10:00:00.000Z');
    await readThread('pod-y', 'u1', '2026-11-15T10:00:00.000Z');
    expect(await seedPodReadPoint({ podId: 'pod-b', userId: 'u1', now: NOW })).toBe('2026-11-13T10:00:00.000Z');
  });

  it('never moves a real read point, earlier or later', async () => {
    // markRead clamps to the real clock, so these points sit in the past.
    await PodReadPoint.markRead('pod-c', 'u1', at('2026-11-05T00:00:00.000Z'));
    await say('pod-c', 'u1', '2026-11-10T00:00:00.000Z');
    expect(await seedPodReadPoint({ podId: 'pod-c', userId: 'u1', now: NOW })).toBe('2026-11-05T00:00:00.000Z');
    await PodReadPoint.markRead('pod-d', 'u1', at('2026-11-10T00:00:00.000Z'));
    expect(await seedPodReadPoint({
      podId: 'pod-d', userId: 'u1', lastActive: at('2026-11-01T00:00:00.000Z'), now: NOW,
    })).toBe('2026-11-10T00:00:00.000Z');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const first = await seedPodReadPoint({
      podId: 'pod-e', userId: 'u1', lastActive: at('2026-11-14T00:00:00.000Z'), now: NOW,
    });
    expect(first).toBe('2026-11-14T00:00:00.000Z');
    expect(await seedPodReadPoint({
      podId: 'pod-e', userId: 'u1', lastActive: at('2026-11-15T00:00:00.000Z'), now: NOW,
    })).toBe(first);
  });

  it('writes nothing with no signal', async () => {
    expect(await seedPodReadPoint({ podId: 'pod-f', userId: 'u1', now: NOW })).toBeNull();
    const { rows } = await mockPool.query("SELECT 1 FROM pod_read_points WHERE pod_id = 'pod-f'");
    expect(rows).toHaveLength(0);
  });

  it('after a seed, the read point still moves forward as before', async () => {
    await seedPodReadPoint({ podId: 'pod-g', userId: 'u1', lastActive: at('2026-11-14T00:00:00.000Z'), now: NOW });
    const later = new Date(Date.now() - 1000).toISOString();
    expect(await PodReadPoint.markRead('pod-g', 'u1', new Date(later))).toBe(later);
  });
});

describe('seedAllPodReadPoints', () => {
  // eslint-disable-next-line global-require
  const { seedAllPodReadPoints } = require('../../../services/podReadPointSeed');

  it('counts first and writes nothing on a dry run', async () => {
    await say('pod-h', 'u1', '2026-11-10T00:00:00.000Z');
    const counts = await seedAllPodReadPoints({
      pods: [{ podId: 'pod-h', memberIds: ['u1', 'u2', 'agent-1', 'u3'] }],
      lastActiveByUser: new Map([['u1', at('2026-11-12T00:00:00Z')], ['u2', at('2026-11-11T00:00:00Z')], ['u3', null]]),
      apply: false,
      now: NOW,
    });
    expect(counts).toEqual({
      members: 3, existing: 0, fromPod: 1, fromLastActive: 1, none: 1,
    });
    const { rows } = await mockPool.query("SELECT 1 FROM pod_read_points WHERE pod_id = 'pod-h'");
    expect(rows).toHaveLength(0);
  });

  it('applies the pod signal first, last-active second, and skips agents and real points', async () => {
    await say('pod-i', 'u1', '2026-11-10T00:00:00.000Z');
    await PodReadPoint.markRead('pod-i', 'u4', at('2026-11-03T00:00:00.000Z'));
    const run = () => seedAllPodReadPoints({
      pods: [{ podId: 'pod-i', memberIds: ['u1', 'u2', 'u4', 'agent-1'] }],
      lastActiveByUser: new Map([
        ['u1', at('2026-11-12T00:00:00Z')], ['u2', at('2026-11-11T00:00:00Z')], ['u4', at('2026-11-12T00:00:00Z')],
      ]),
      apply: true,
      now: NOW,
    });
    expect(await run()).toEqual({
      members: 3, existing: 1, fromPod: 1, fromLastActive: 1, none: 0,
    });
    expect(await PodReadPoint.get('pod-i', 'u1')).toBe('2026-11-10T00:00:00.000Z');
    expect(await PodReadPoint.get('pod-i', 'u2')).toBe('2026-11-11T00:00:00.000Z');
    expect(await PodReadPoint.get('pod-i', 'u4')).toBe('2026-11-03T00:00:00.000Z');
    expect(await PodReadPoint.get('pod-i', 'agent-1')).toBeNull();
    // A second run finds every seeded member already has a point.
    expect(await run()).toEqual({
      members: 3, existing: 3, fromPod: 0, fromLastActive: 0, none: 0,
    });
  });
});
