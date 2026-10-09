const mongoose = require('mongoose');
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
const { AgentInstallation, AgentRegistry } = require('../../../models/AgentRegistry');
const { reviveNativeInstallations, declaredExemptRuntime } = require('../../../scripts/revive-native-installations');
const { isStalenessExempt } = require('../../../services/agentInstallationCleanupService');
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

  // The early first-teammate shape: no `config.runtime` at all (or no config).
  // Raw inserts, because the point is a row the schema's defaults never touched.
  const makePreRuntime = (agentName, staleSince, config) => AgentInstallation.collection.insertOne({
    agentName,
    podId: new mongoose.Types.ObjectId(),
    instanceId: 'default',
    version: '1.0.0',
    installedBy,
    status: 'stale',
    staleSince,
    ...(config === undefined ? {} : { config }),
    createdAt: staleSince,
    updatedAt: staleSince,
  });

  // The seed's own upsert shape: `runtimeType` is dropped by the strict
  // subschema and only `type: 'native'` survives — the script must read that.
  const seedRegistry = (agentName, runtime) => AgentRegistry.findOneAndUpdate(
    { agentName },
    {
      $set: {
        displayName: agentName,
        description: 'd',
        registry: 'commonly-official',
        status: 'active',
        latestVersion: '1.0.0',
        manifest: {
          name: agentName, version: '1.0.0', description: 'd', runtime,
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const seedPreRuntime = async () => {
    const staleAt = new Date(Date.now() - 9 * DAY_MS);
    await seedRegistry('scout', { type: 'native', runtimeType: 'native' });
    await seedRegistry('shaped', { type: 'standalone' });
    await makePreRuntime('scout', staleAt, {});
    await makePreRuntime('scout', new Date(Date.now() - 8 * DAY_MS), undefined);
    await makePreRuntime('shaped', staleAt, {});
    await makePreRuntime('ghost', staleAt, { runtime: {} });
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
    expect(result.backfill).toEqual({
      candidates: 0, eligible: 0, byAgent: [], skipped: [], applied: 0,
    });
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

  describe('pre-runtime rows (no config.runtime.runtimeType)', () => {
    it('declaredExemptRuntime reads runtimeType or type and refuses deployment-shape values', () => {
      expect(declaredExemptRuntime({ manifest: { runtime: { runtimeType: 'native' } } })).toBe('native');
      expect(declaredExemptRuntime({ manifest: { runtime: { type: 'native' } } })).toBe('native');
      expect(declaredExemptRuntime({ manifest: { runtime: { type: 'Native ' } } })).toBe('native');
      expect(declaredExemptRuntime({ manifest: { runtime: { type: 'standalone' } } })).toBe('');
      expect(declaredExemptRuntime({ manifest: { runtime: { type: 'hybrid', runtimeType: 'internal' } } })).toBe('');
      expect(declaredExemptRuntime({ manifest: {} })).toBe('');
      expect(declaredExemptRuntime(null)).toBe('');
    });

    it('the seed upsert now carries runtimeType; the `type` fallback stays necessary for rows written before it', async () => {
      await seedRegistry('scout', { type: 'native', runtimeType: 'native' });
      const stored = await AgentRegistry.collection.findOne({ agentName: 'scout' });
      // TASK-043 declared `runtimeType` on ManifestRuntimeSchema, so it persists
      // where it used to be dropped — that is the field the boot seeder writes
      // now. `type` still persists too: it is enum-invalid ('native' is not a
      // deployment shape) but findOneAndUpdate does not run validators, so every
      // row the old seeder wrote carries it and declaredExemptRuntime's `type`
      // fallback is still load-bearing. Read order is asserted above.
      expect(stored.manifest.runtime.runtimeType).toBe('native');
      expect(stored.manifest.runtime.type).toBe('native');
    });

    it('dry run counts eligible pre-runtime rows, names the skipped ones, and writes nothing', async () => {
      const { staleAt } = await seed();
      const pre = await seedPreRuntime();

      const result = await reviveNativeInstallations();

      expect(result.candidates).toBe(4);
      expect(result.byAgent).toEqual([{
        agentName: 'scout', instanceId: 'default', count: 4, oldestStaleSince: pre.staleAt,
      }]);
      expect(result.backfill).toEqual({
        candidates: 4,
        eligible: 2,
        byAgent: [{
          agentName: 'scout', instanceId: 'default', count: 2, oldestStaleSince: pre.staleAt,
        }],
        skipped: [
          { agentName: 'ghost', count: 1, reason: 'no registry row' },
          { agentName: 'shaped', count: 1, reason: 'registry row declares no exempt runtime' },
        ],
        applied: 0,
      });
      expect(result.revived).toBe(0);
      expect(staleAt).toBeInstanceOf(Date);
      expect(await AgentInstallation.countDocuments({ status: 'stale' })).toBe(8);
      expect(await AgentInstallation.countDocuments({ 'config.runtime.runtimeType': { $exists: false } })).toBe(4);
    });

    it('apply backfills runtimeType from the registry, then revives, and leaves undeclared rows stale', async () => {
      await seed();
      await seedPreRuntime();

      const result = await reviveNativeInstallations({ apply: true });

      expect(result.backfill.applied).toBe(2);
      expect(result.revived).toBe(4);
      const scout = await AgentInstallation.find({ agentName: 'scout' }).lean();
      expect(scout).toHaveLength(5);
      expect(scout.every((row) => row.status === 'active' && row.staleSince == null)).toBe(true);
      expect(scout.every((row) => row.config?.runtime?.runtimeType === 'native')).toBe(true);
      expect(await statusOf('shaped')).toEqual([{ status: 'stale', staleSince: expect.any(Date) }]);
      expect(await statusOf('ghost')).toEqual([{ status: 'stale', staleSince: expect.any(Date) }]);
      expect(await AgentInstallation.countDocuments({ 'config.runtime.runtimeType': { $exists: false } })).toBe(2);
    });

    it('a backfilled row survives the sweep: it now carries the exempt runtimeType', async () => {
      await seedPreRuntime();
      await reviveNativeInstallations({ apply: true });

      const scout = await AgentInstallation.find({ agentName: 'scout' }).lean();
      expect(scout.map((row) => isStalenessExempt(row))).toEqual([true, true]);
    });

    it('is idempotent across pre-runtime rows too', async () => {
      await seedPreRuntime();
      await reviveNativeInstallations({ apply: true });

      const again = await reviveNativeInstallations({ apply: true });

      expect(again.candidates).toBe(0);
      expect(again.backfill.eligible).toBe(0);
      expect(again.backfill.skipped).toHaveLength(2);
      expect(again.revived).toBe(0);
    });
  });
});
