/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// The repository's Postgres table is the in-memory adapter here (dual and pg
// suites below); the real SQL runs in __tests__/service/agentPodReadCursor.realPg.test.js.
const mockPg = { current: null, options: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: (options) => {
      mockPg.options = options;
      return Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan'].map((m) => [m, forward(m)]));
    },
  };
});
const mongoose = require('mongoose');
const Cursor = require('../../../models/AgentPodReadCursor');
const {
  getReadWatermark, advanceReadWatermark, readCursorStore,
} = require('../../../repositories/agentPodReadCursorRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const at = (seconds) => new Date(Date.UTC(2026, 9, 25, 0, 0, seconds));
describe('read cursor repository (Mongo implementation)', () => {
  const agent = new mongoose.Types.ObjectId();
  const pod = new mongoose.Types.ObjectId();
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => { await Cursor.deleteMany({}); });

  it('returns null for an absent cursor and only a plain watermark after a round trip', async () => {
    expect(await getReadWatermark(agent, pod)).toBeNull();
    await advanceReadWatermark(agent, pod, { readAt: at(1) });
    const value = await getReadWatermark(agent, pod);
    expect(value).toEqual({ readAt: at(1) });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value.save).toBeUndefined();
    const row = await Cursor.findById(`${agent}:${pod}`).lean();
    expect(String(row.agentUserId)).toBe(String(agent));
    expect(String(row.podId)).toBe(String(pod));
    expect(row.readRevision).toBeUndefined();
  });

  it('preserves independent maxima and an existing revision when omitted', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(2), readRevision: 3 });
    await advanceReadWatermark(agent, pod, { readAt: at(1), readRevision: 5 });
    expect(await getReadWatermark(String(agent), String(pod))).toEqual({ readAt: at(2), readRevision: 5 });
    await advanceReadWatermark(agent, pod, { readAt: at(4) });
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(4), readRevision: 5 });
  });

  it('isolates both the agent and pod parts of the key', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(2) });
    expect(await getReadWatermark(new mongoose.Types.ObjectId(), pod)).toBeNull();
    expect(await getReadWatermark(agent, new mongoose.Types.ObjectId())).toBeNull();
  });

  it('concurrent first reads converge on one row without rolling either maximum back', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => advanceReadWatermark(agent, pod, {
      readAt: at(i), readRevision: 20 - i,
    })));
    expect(await Cursor.countDocuments({})).toBe(1);
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(19), readRevision: 20 });
  });

  it('retries only duplicate-key upserts and propagates other write/read errors', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(1) });
    // The write is one findOneAndUpdate since step 2 (repositories/dualStore.ts upsert).
    const rejecting = (error) => () => ({ lean: () => Promise.reject(error) });
    const update = jest.spyOn(Cursor, 'findOneAndUpdate')
      .mockImplementationOnce(rejecting(Object.assign(new Error('duplicate'), { code: 11000 })));
    await advanceReadWatermark(agent, pod, { readAt: at(2), readRevision: 0 });
    expect(update.mock.calls[1][0]).toMatchObject({ _id: `${agent}:${pod}` });
    expect(update.mock.calls[1][2]).toEqual({ new: true });
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(2), readRevision: 0 });
    update.mockImplementationOnce(rejecting(new Error('down')));
    await expect(advanceReadWatermark(agent, pod, { readAt: at(3) })).rejects.toThrow('down');
    jest.spyOn(Cursor, 'findOne').mockImplementationOnce(() => { throw new Error('read down'); });
    await expect(getReadWatermark(agent, pod)).rejects.toThrow('read down');
  });
});

const ENV = 'STORE_MODE_AGENT_POD_READ_CURSOR';

describe('read cursor table wiring', () => {
  it('names the columns 0016 creates, and nothing else', () => {
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0016_agent_pod_read_cursors.sql'), 'utf8');
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER|BIGINT)/gm)].map((m) => m[1]);
    expect(mockPg.options).toMatchObject({ table: 'agent_pod_read_cursors', idColumn: 'id', bigintColumns: ['read_revision'] });
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
  });
});

describe.each(['dual', 'pg'])('read cursor repository (%s mode)', (mode) => {
  const agent = new mongoose.Types.ObjectId();
  const pod = new mongoose.Types.ObjectId();
  const key = `${agent}:${pod}`;
  let pg;
  let warn;
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Cursor.deleteMany({});
    pg = fakePg();
    mockPg.current = pg;
    process.env[ENV] = mode;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  /** In dual, Mongo and the row must agree after every write; in pg, Mongo stays empty. */
  const expectStoresAgree = async () => {
    if (mode === 'pg') {
      expect(await Cursor.countDocuments({})).toBe(0);
      return;
    }
    expect(await Cursor.countDocuments({ pgPending: { $exists: true } })).toBe(0);
    expect(await readCursorStore.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
  };

  it('returns null for an absent cursor and only a plain watermark after a round trip', async () => {
    expect(await getReadWatermark(agent, pod)).toBeNull();
    await advanceReadWatermark(agent, pod, { readAt: at(1) });
    const value = await getReadWatermark(agent, pod);
    expect(value).toEqual({ readAt: at(1) });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(pg.rows.get(key)).toEqual({
      row: {
        id: key, agent_user_id: String(agent), pod_id: String(pod), read_at: at(1), read_revision: null,
      },
      version: 1,
    });
    await expectStoresAgree();
  });

  it('preserves independent maxima and an existing revision when omitted', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(2), readRevision: 3 });
    await advanceReadWatermark(agent, pod, { readAt: at(1), readRevision: 5 });
    expect(await getReadWatermark(String(agent), String(pod))).toEqual({ readAt: at(2), readRevision: 5 });
    await advanceReadWatermark(agent, pod, { readAt: at(4) });
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(4), readRevision: 5 });
    expect(pg.rows.get(key).version).toBe(3);
    await expectStoresAgree();
  });

  it('isolates both the agent and pod parts of the key', async () => {
    await advanceReadWatermark(agent, pod, { readAt: at(2) });
    expect(await getReadWatermark(new mongoose.Types.ObjectId(), pod)).toBeNull();
    expect(await getReadWatermark(agent, new mongoose.Types.ObjectId())).toBeNull();
  });

  it('concurrent first reads converge on one row without rolling either maximum back', async () => {
    // pg mode retries a lost read-modify-write a bounded number of times, so
    // its race is five writers, not twenty; dual leans on Mongo's atomic write.
    const writers = mode === 'pg' ? 5 : 20;
    await Promise.all(Array.from({ length: writers }, (_, i) => advanceReadWatermark(agent, pod, {
      readAt: at(i), readRevision: writers - i,
    })));
    expect(pg.rows.size).toBe(1);
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(writers - 1), readRevision: writers });
    await expectStoresAgree();
  });

  it('a Postgres failure: dual keeps the caller whole and flags it; pg propagates', async () => {
    pg.failNext(mode === 'pg' ? 'get' : 'upsert');
    const writing = advanceReadWatermark(agent, pod, { readAt: at(1) });
    if (mode === 'pg') {
      await expect(writing).rejects.toThrow('fake get failed');
      return;
    }
    await writing;
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(1) });
    expect((await Cursor.findById(key).lean()).pgPending).toBe(1);
    expect(warn.mock.calls.join('\n')).not.toContain(String(agent));
    expect(await readCursorStore.repair()).toMatchObject({ copied: 1 });
    await expectStoresAgree();
  });
});

describe('read cursor parity: the Mongo pipeline and the JS merge agree', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(() => { delete process.env[ENV]; });

  // Out of order, revision-only (an older readAt with a higher revision),
  // readAt-only (no revision), a revision of 0, and repeats of the current value.
  const SEQUENCES = {
    'starts without a revision': [
      { readAt: at(5) }, { readAt: at(3), readRevision: 2 }, { readAt: at(4), readRevision: 7 },
      { readAt: at(9) }, { readAt: at(1), readRevision: 3 }, { readAt: at(9), readRevision: 7 },
      { readAt: at(6), readRevision: 8 },
    ],
    'starts with revision 0': [
      { readAt: at(2), readRevision: 0 }, { readAt: at(1) }, { readAt: at(1), readRevision: 0 },
      { readAt: at(3), readRevision: -1 }, { readAt: at(0), readRevision: 4 },
    ],
    'only ever moves back': [
      { readAt: at(50), readRevision: 50 }, { readAt: at(40), readRevision: 40 }, { readAt: at(30) },
    ],
  };

  it.each(Object.keys(SEQUENCES))('%s: the same watermark after every step in mongo, dual and pg', async (label) => {
    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    const trace = {};
    for (const mode of ['mongo', 'dual', 'pg']) {
      await Cursor.deleteMany({});
      mockPg.current = fakePg();
      if (mode === 'mongo') delete process.env[ENV];
      else process.env[ENV] = mode;
      trace[mode] = [];
      for (const watermark of SEQUENCES[label]) {
        await advanceReadWatermark(agent, pod, watermark);
        trace[mode].push(await getReadWatermark(agent, pod));
      }
      if (mode === 'dual') {
        expect(await readCursorStore.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
      }
    }
    expect(trace.dual).toEqual(trace.mongo);
    expect(trace.pg).toEqual(trace.mongo);
  });
});

describe('read cursor in pg mode: two writers on the version they both read', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(() => { delete process.env[ENV]; });

  it('keeps both maxima: the loser of the compare-and-set re-reads and merges onto the winner', async () => {
    process.env[ENV] = 'pg';
    const pg = fakePg();
    mockPg.current = pg;
    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    await advanceReadWatermark(agent, pod, { readAt: at(0), readRevision: 0 });
    // A barrier: neither replacement applies until both have read version 1.
    const { replace } = pg;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const versionsRead = [];
    pg.replace = async (row, version) => {
      if (versionsRead.length < 2) {
        versionsRead.push(version);
        if (versionsRead.length === 2) release();
        await barrier;
      }
      return replace(row, version);
    };
    await Promise.all([
      advanceReadWatermark(agent, pod, { readAt: at(9), readRevision: 1 }),
      advanceReadWatermark(agent, pod, { readAt: at(1), readRevision: 9 }),
    ]);
    expect(versionsRead).toEqual([1, 1]);
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(9), readRevision: 9 });
    expect(pg.rows.get(`${agent}:${pod}`).version).toBe(3);
  });
});
