/**
 * F576, the Postgres store: the first-listen rewrite of a never-connected
 * install intro, against pg-mem's messages table (production's store). The
 * route-level ordering is in installIntroOnFirstListen.test.js.
 */
const { newDb } = require('pg-mem');

const pg = newDb();
pg.public.none(`CREATE TABLE messages (
  id SERIAL PRIMARY KEY, pod_id TEXT NOT NULL, user_id TEXT NOT NULL,
  content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', author_kind TEXT, payload JSONB,
  summary TEXT, updated_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
const { Pool } = pg.adapters.createPg();
const mockPool = new Pool();
jest.mock('../../config/db-pg', () => ({ pool: mockPool }));
const mockEmits = [];
jest.mock('../../config/socket', () => ({
  getIO: () => ({ to: (room) => ({ emit: (event, body) => mockEmits.push({ room, event, body }) }) }),
}));

const { composeInstallIntro } = require('../../routes/registry/helpers');
const { settleInstallIntroOnFirstListen, isFirstListen } = require('../../services/installIntroOnListen');

const AGENT = 'agent-user-1';
const POD = 'pod-1';
const intro = (state) => composeInstallIntro({
  displayName: 'Rivet', blurb: 'I review pull requests.', handle: 'rivet', state, fixCommand: 'npx x agent run rivet',
});
const insert = (content, { userId = AGENT, podId = POD, kind = 'install-intro', authorKind = 'kernel' } = {}) => mockPool.query(
  'INSERT INTO messages (pod_id, user_id, content, author_kind, payload) VALUES ($1, $2, $3, $4, $5) RETURNING id',
  [podId, userId, content, authorKind, kind ? JSON.stringify({ kind }) : null],
);
const rowOf = async (id) => (await mockPool.query('SELECT content, payload FROM messages WHERE id = $1', [id])).rows[0];

const previousHost = process.env.PG_HOST;
beforeAll(() => { process.env.PG_HOST = 'pg-mem'; });
afterAll(() => {
  if (previousHost === undefined) delete process.env.PG_HOST;
  else process.env.PG_HOST = previousHost;
});
beforeEach(async () => {
  await mockPool.query('DELETE FROM messages');
  mockEmits.length = 0;
});

describe('first-listen intro rewrite on Postgres (F576)', () => {
  it('rewrites a never-connected intro, keeps its blurb, marks it and emits once', async () => {
    const { rows: [{ id }] } = await insert(intro('never-connected'));
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT, podIds: [POD] })).toBe(1);
    const row = await rowOf(id);
    expect(row.content).toBe(intro('listening'));
    expect(row.content).toContain('I review pull requests.');
    expect(row.payload).toEqual({ kind: 'install-intro', introState: 'listening' });
    expect(mockEmits).toEqual([{
      room: `pod_${POD}`,
      event: 'messageUpdated',
      body: { messageId: String(id), podId: POD, content: intro('listening'), payload: row.payload },
    }]);
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT, podIds: [POD] })).toBe(0);
  });

  it('rewrites a gone-dark intro too: it carries the same never-updates pointer', async () => {
    const { rows: [{ id }] } = await insert(intro('gone-dark'));
    await settleInstallIntroOnFirstListen({ agentUserId: AGENT, podIds: [POD] });
    expect((await rowOf(id)).content).toBe(intro('listening'));
  });

  it('leaves a listening intro, a no-listener intro, another agent\'s intro and other pods alone', async () => {
    const live = await insert(intro('listening'));
    const noListener = await insert(composeInstallIntro({
      displayName: 'Rivet', handle: 'rivet', state: 'never-connected', fixCommand: 'x', listens: false,
    }));
    const others = await insert(intro('never-connected'), { userId: 'agent-user-2' });
    const elsewhere = await insert(intro('never-connected'), { podId: 'pod-2' });
    const plain = await insert(intro('never-connected'), { kind: null });
    expect(await settleInstallIntroOnFirstListen({ agentUserId: AGENT, podIds: [POD] })).toBe(0);
    for (const res of [live, noListener, others, elsewhere, plain]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await rowOf(res.rows[0].id)).payload?.introState).toBeUndefined();
    }
    expect(mockEmits).toHaveLength(0);
  });

  it('a second write failing still announces the first', async () => {
    const first = await insert(intro('never-connected'));
    await insert(intro('never-connected'), { podId: 'pod-2' });
    const real = mockPool.query.bind(mockPool);
    let updates = 0;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(mockPool, 'query').mockImplementation((sql, params) => {
      if (/^\s*UPDATE/i.test(sql)) {
        updates += 1;
        if (updates === 2) return Promise.reject(new Error('pg down'));
      }
      return real(sql, params);
    });
    try {
      await settleInstallIntroOnFirstListen({ agentUserId: AGENT, podIds: [POD, 'pod-2'] });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    const written = (await mockPool.query(
      "SELECT id FROM messages WHERE payload->>'introState' = 'listening'",
    )).rows.map((r) => String(r.id));
    expect(written).toHaveLength(1);
    // Rows are read newest first, so the first write is the pod-2 intro.
    expect(written).not.toContain(String(first.rows[0].id));
    expect(mockEmits.map((e) => e.body.messageId)).toEqual(written);
  });

  it('a failing store logs and answers 0, never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(mockPool, 'query').mockRejectedValueOnce(new Error('pg down'));
    try {
      await expect(settleInstallIntroOnFirstListen({ agentUserId: AGENT, podIds: [POD] })).resolves.toBe(0);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('isFirstListen reads the records already loaded', () => {
  it('first only when the token is on file and no copy has listened', () => {
    expect(isFirstListen('h', [[{ tokenHash: 'h' }]])).toBe(true);
    expect(isFirstListen('h', [[{ tokenHash: 'h' }], [{ tokenHash: 'h', lastListenedAt: new Date() }]])).toBe(false);
    expect(isFirstListen('h', [[{ tokenHash: 'other' }], undefined])).toBe(false);
    expect(isFirstListen(undefined, [[{ tokenHash: 'h' }]])).toBe(false);
  });
});
