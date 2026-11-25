/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 D3: the registry of dual-stored models, and the five-minute repair
 * pass over it. Runs on a real Mongo with the in-memory Postgres adapter.
 */
const mockPg = { current: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: () => Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan']
      .map((m) => [m, forward(m)])),
  };
});
const mongoose = require('mongoose');
const Cursor = require('../../../models/AgentPodReadCursor');
const { advanceReadWatermark } = require('../../../repositories/agentPodReadCursorRepository');
const { DUAL_STORED_MODELS, repairDualStoredModels } = require('../../../repositories/dualStoreRegistry');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_POD_READ_CURSOR';

describe('dual-store registry and repair pass', () => {
  let log;
  let error;
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Cursor.deleteMany({});
    mockPg.current = fakePg();
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  it('lists the read cursor and the first-contact marker, whose stores have every operation the script and the job use', () => {
    expect(Object.keys(DUAL_STORED_MODELS)).toEqual(['AgentPodReadCursor', 'AgentFirstContact']);
    Object.values(DUAL_STORED_MODELS).forEach((open) => {
      const store = open();
      ['repair', 'backfill', 'verify', 'upsert', 'findById'].forEach((op) => expect(typeof store[op]).toBe('function'));
    });
  });

  it.each([undefined, 'mongo', 'pg'])('skips a model whose mode is %p, with no Postgres call', async (mode) => {
    if (mode) process.env[ENV] = mode;
    await Cursor.create({
      _id: 'x:y', agentUserId: new mongoose.Types.ObjectId(), podId: new mongoose.Types.ObjectId(), readAt: new Date(), pgVersion: 1, pgPending: 1,
    });
    expect(await repairDualStoredModels()).toEqual({});
    expect(mockPg.current.calls).toEqual([]);
    expect((await Cursor.findById('x:y').lean()).pgPending).toBe(1);
  });

  it.each(['dual', 'pg-read'])('%s: repairs a flagged cursor, logging non-zero counts only and no id', async (mode) => {
    process.env[ENV] = mode;
    expect(await repairDualStoredModels()).toEqual({
      AgentPodReadCursor: {
        scanned: 0, copied: 0, deleted: 0, failed: 0,
      },
    });
    expect(log).not.toHaveBeenCalled();

    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    mockPg.current.failNext('upsert');
    await advanceReadWatermark(agent, pod, { readAt: new Date() });
    expect(await repairDualStoredModels()).toEqual({
      AgentPodReadCursor: {
        scanned: 1, copied: 1, deleted: 0, failed: 0,
      },
    });
    expect(log.mock.calls.map((c) => c.join(' '))).toEqual(['[dual-store] repair model=AgentPodReadCursor scanned=1 copied=1']);
    expect(mockPg.current.rows.size).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(String(agent));
  });

  it('a failing repair is logged and does not throw out of the pass', async () => {
    process.env[ENV] = 'dual';
    jest.spyOn(Cursor, 'find').mockImplementationOnce(() => { throw new Error('mongo down'); });
    await expect(repairDualStoredModels()).resolves.toEqual({});
    expect(error).toHaveBeenCalledWith('[dual-store] repair failed model=AgentPodReadCursor:', 'mongo down');
  });
});
