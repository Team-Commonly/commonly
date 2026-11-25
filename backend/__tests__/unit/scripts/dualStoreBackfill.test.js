/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * scripts/dual-store-backfill.ts: argument parsing, and main() over the real
 * read-cursor store on a real Mongo with the in-memory Postgres adapter.
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
const { DUAL_STORED_MODELS } = require('../../../repositories/dualStoreRegistry');
const { parseArgs, main } = require('../../../scripts/dual-store-backfill');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_POD_READ_CURSOR';
const MODELS = ['AgentPodReadCursor'];
const argv = (...args) => ['node', 'dual-store-backfill', ...args];

describe('dual-store-backfill arguments', () => {
  it('defaults to a dry run and reads each action', () => {
    expect(parseArgs(argv('--model', 'AgentPodReadCursor'), MODELS)).toEqual({ model: 'AgentPodReadCursor', action: 'dry-run' });
    expect(parseArgs(argv('--model=AgentPodReadCursor', '--apply'), MODELS).action).toBe('apply');
    expect(parseArgs(argv('--verify', '--model', 'AgentPodReadCursor'), MODELS).action).toBe('verify');
    expect(parseArgs(argv('--dry-run', '--model', 'AgentPodReadCursor'), MODELS).action).toBe('dry-run');
  });

  it.each([
    [[], /--model must be one of AgentPodReadCursor; got nothing/],
    [['--model', 'Pod'], /got "Pod"/],
    [['--model', 'AgentPodReadCursor', '--apply', '--verify'], /exclusive/],
    [['--model', 'AgentPodReadCursor', '--aply'], /unknown argument "--aply"/],
    [['--model'], /--model needs a model name/],
    [['--model='], /--model needs a model name/],
    [['--model', '--dry-run', '--model', 'AgentPodReadCursor', '--apply'], /--model needs a model name/],
    [['--model', 'AgentPodReadCursor', '--model', 'AgentPodReadCursor'], /more than once/],
  ])('refuses %p', (args, message) => {
    expect(() => parseArgs(argv(...args), MODELS)).toThrow(message);
  });
});

describe('dual-store-backfill main', () => {
  let log;
  let closed;
  const open = async () => ({ models: DUAL_STORED_MODELS, close: async () => { closed += 1; } });
  const printed = () => log.mock.calls.map((c) => c.join(' ')).join('\n');
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Cursor.deleteMany({});
    mockPg.current = fakePg();
    closed = 0;
    process.exitCode = undefined;
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[ENV];
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  const seedHistory = async () => {
    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    // Written in mongo mode, before dual: no version, no row.
    await Cursor.create({
      _id: `${agent}:${pod}`, agentUserId: agent, podId: pod, readAt: new Date(), readRevision: 4,
    });
    return `${agent}:${pod}`;
  };

  it('refuses a dry run or --apply outside dual, after closing the stores', async () => {
    await seedHistory();
    await expect(main(argv('--model', 'AgentPodReadCursor', '--apply'), open, MODELS)).rejects.toThrow(/=dual or pg-read, not mongo/);
    expect(closed).toBe(1);
    expect(mockPg.current.rows.size).toBe(0);
  });

  it('dry run, apply, then a clean verify; counts and checksums only', async () => {
    const id = await seedHistory();
    process.env[ENV] = 'dual';
    expect(await main(argv('--model', 'AgentPodReadCursor'), open, MODELS)).toBe(0);
    expect(printed()).toContain('dry-run model=AgentPodReadCursor {"scanned":1,"inserted":1,"alreadyCurrent":0,"deferredPending":0}');
    expect(mockPg.current.rows.size).toBe(0);

    expect(await main(argv('--model', 'AgentPodReadCursor', '--apply'), open, MODELS)).toBe(0);
    expect(mockPg.current.rows.get(id).version).toBe(0);

    expect(await main(argv('--model', 'AgentPodReadCursor', '--verify'), open, MODELS)).toBe(0);
    expect(printed()).toMatch(/verify model=AgentPodReadCursor \{"mongo":1,"pg":1,"missing":0,"differs":0,"extra":0,"checksumMongo":"([0-9a-f]{64})","checksumPg":"\1"\}/);
    expect(printed()).not.toContain(id.split(':')[0]);
    expect(closed).toBe(3);
  });

  it('verify exits 1 on a difference', async () => {
    const id = await seedHistory();
    process.env[ENV] = 'dual';
    await main(argv('--model', 'AgentPodReadCursor', '--apply'), open, MODELS);
    mockPg.current.rows.get(id).row.read_revision = 3;
    expect(await main(argv('--model', 'AgentPodReadCursor', '--verify'), open, MODELS)).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(printed()).toContain('"differs":1');
  });
});
