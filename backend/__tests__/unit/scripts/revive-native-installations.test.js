const mongoose = require('mongoose');
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { reviveNativeInstallations } = require('../../../scripts/revive-native-installations');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('revive-native-installations', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  const installedBy = new mongoose.Types.ObjectId();
  const make = (agentName, runtimeType, status, staleSince) => AgentInstallation.create({
    agentName,
    podId: new mongoose.Types.ObjectId(),
    instanceId: 'default',
    version: '1.0.0',
    installedBy,
    status,
    staleSince,
    config: { runtime: { runtimeType } },
  });

  const seed = async () => {
    const staleAt = new Date(Date.now() - 3 * DAY_MS);
    await make('scout', 'native', 'stale', staleAt);
    await make('scout', 'native', 'stale', new Date(Date.now() - 1 * DAY_MS));
    await make('scout', 'native', 'active');
    await make('legacy', 'internal', 'stale', staleAt);
    await make('nova', 'moltbot', 'stale', staleAt);
    return { staleAt };
  };

  const statusOf = async (agentName) => (await AgentInstallation.find({ agentName }).sort({ staleSince: 1 }).lean())
    .map((row) => ({ status: row.status, staleSince: row.staleSince ?? null }));

  it('dry run counts stale native rows only and changes nothing', async () => {
    const { staleAt } = await seed();

    const result = await reviveNativeInstallations();

    expect(result.apply).toBe(false);
    expect(result.candidates).toBe(2);
    expect(result.revived).toBe(0);
    expect(result.byAgent).toEqual([{
      agentName: 'scout', instanceId: 'default', count: 2, oldestStaleSince: staleAt,
    }]);
    expect(await AgentInstallation.countDocuments({ status: 'stale' })).toBe(4);
  });

  it('apply revives the stale native rows, clears staleSince, and leaves internal and remote rows stale', async () => {
    await seed();

    const result = await reviveNativeInstallations({ apply: true });

    expect(result.candidates).toBe(2);
    expect(result.revived).toBe(2);
    expect(await statusOf('scout')).toEqual([
      { status: 'active', staleSince: null },
      { status: 'active', staleSince: null },
      { status: 'active', staleSince: null },
    ]);
    expect(await statusOf('legacy')).toEqual([{ status: 'stale', staleSince: expect.any(Date) }]);
    expect(await statusOf('nova')).toEqual([{ status: 'stale', staleSince: expect.any(Date) }]);
  });

  it('is idempotent: a second apply finds nothing', async () => {
    await seed();
    await reviveNativeInstallations({ apply: true });

    const again = await reviveNativeInstallations({ apply: true });

    expect(again.candidates).toBe(0);
    expect(again.revived).toBe(0);
  });
});
