// TASK-569: attach writes a seat's runtime identity only onto the install
// where it ran, so the same seat showed a chip in one pod and none in another.
// Every pod now reads the seat's identity from its most recently attached
// install, never the first match, so a harness swap shows everywhere. "Most
// recent" is runtimeIdentityAt, which only identity writes move: updatedAt
// moved on a skill-load report and revived a stale harness.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  resolveSeatRuntimeIdentities,
  buildAgentInstallationPayload,
} = require('../../../routes/registry/helpers');

const owner = new mongoose.Types.ObjectId();
const podA = new mongoose.Types.ObjectId();
const podB = new mongoose.Types.ObjectId();
const podC = new mongoose.Types.ObjectId();

const install = (podId, runtime, extra = {}) => AgentInstallation.create({
  agentName: 'sprint-review',
  instanceId: 'default',
  podId,
  version: '1.0.0',
  installedBy: owner,
  status: 'active',
  config: runtime ? { runtime } : {},
  ...extra,
});

// Rewrites the identity clock directly so the order of attaches is explicit.
const stamp = (doc, iso) => AgentInstallation.collection.updateOne(
  { _id: doc._id }, { $set: { runtimeIdentityAt: new Date(iso) } },
);
const raw = (doc) => AgentInstallation.collection.findOne({ _id: doc._id });

const runtimeIn = async (doc) => {
  const fresh = await AgentInstallation.findById(doc._id).lean();
  const identities = await resolveSeatRuntimeIdentities([fresh]);
  return buildAgentInstallationPayload(fresh, {
    runtimeIdentity: identities.get('sprint-review:default') || null,
  }).runtime;
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(clearMongoDb);

describe('seat runtime identity across pods', () => {
  it('fills an install that declares no runtime from the seat\'s other install', async () => {
    const declared = await install(podA, { runtimeType: 'claude-code', host: 'byo', adapter: 'claude' });
    const bare = await install(podB, null);
    expect(await runtimeIn(bare)).toMatchObject({ runtimeType: 'claude-code', host: 'byo', adapter: 'claude' });
    expect(await runtimeIn(declared)).toMatchObject({ runtimeType: 'claude-code', adapter: 'claude' });
  });

  it('a seat attached as codex in pod A, then re-attached as claude in pod B, shows claude in both', async () => {
    const a = await install(podA, { runtimeType: 'webhook', host: 'byo', adapter: 'codex' });
    const b = await install(podB, { runtimeType: 'claude-code', host: 'byo' });
    await stamp(a, '2020-01-20T00:00:00Z');
    await stamp(b, '2020-01-25T00:00:00Z');
    const inA = await runtimeIn(a);
    const inB = await runtimeIn(b);
    // The group moves whole: pod A's older adapter does not outlive pod B's type.
    expect(inA.runtimeType).toBe('claude-code');
    expect(inA.adapter).toBeUndefined();
    expect(inB.runtimeType).toBe('claude-code');
  });

  it('picks the most recent install, not the first one created', async () => {
    const first = await install(podA, { runtimeType: 'claude-code', host: 'byo' });
    const second = await install(podB, { runtimeType: 'codex', host: 'byo' });
    const bare = await install(podC, null);
    await stamp(first, '2020-01-25T00:00:00Z');
    await stamp(second, '2020-01-21T00:00:00Z');
    expect((await runtimeIn(bare)).runtimeType).toBe('claude-code');
    expect((await runtimeIn(second)).runtimeType).toBe('claude-code');
  });

  it('ignores uninstalled installs and installs of another instance', async () => {
    await install(podA, { runtimeType: 'codex', host: 'byo' }, { status: 'uninstalled' });
    await install(podB, { runtimeType: 'codex', host: 'byo' }, { instanceId: 'other' });
    const bare = await install(podC, null);
    const identities = await resolveSeatRuntimeIdentities([bare]);
    expect(identities.size).toBe(0);
  });

  it('keeps per-install fields and the hosted type', async () => {
    const hosted = await install(podA, { runtimeType: 'hosted', host: 'cloud', model: 'm-1' });
    const bare = await install(podB, { model: 'm-2' });
    await stamp(hosted, '2020-01-25T00:00:00Z');
    const runtime = await runtimeIn(bare);
    expect(runtime).toMatchObject({ runtimeType: 'hosted', host: 'cloud', model: 'm-2' });
  });

  it('a skill-load report on a stale install does not bring its old harness back', async () => {
    const a = await install(podA, { runtimeType: 'webhook', host: 'byo', adapter: 'codex' });
    const b = await install(podB, { runtimeType: 'claude-code', host: 'byo' });
    await stamp(a, '2020-01-20T00:00:00Z');
    await stamp(b, '2020-01-25T00:00:00Z');
    // The exact write agentsRuntime.ts makes for POST .../skill-load.
    await AgentInstallation.updateOne(
      { _id: a._id, status: 'active' },
      { $set: { skillLoad: { at: new Date(), mounted: ['x'], conflicted: [], status: 'available' } } },
    );
    expect((await runtimeIn(a)).runtimeType).toBe('claude-code');
    expect((await runtimeIn(b)).runtimeType).toBe('claude-code');
  });

  it('a settings save that keeps the identity does not move the clock', async () => {
    const a = await install(podA, { runtimeType: 'webhook', host: 'byo', adapter: 'codex' });
    const b = await install(podB, { runtimeType: 'claude-code', host: 'byo' });
    await stamp(a, '2020-01-20T00:00:00Z');
    await stamp(b, '2020-01-25T00:00:00Z');
    // The manage-settings.ts shape: the whole config map rewritten, runtime unchanged.
    const doc = await AgentInstallation.findById(a._id);
    const config = Object.fromEntries(doc.config);
    doc.config = new Map(Object.entries({ ...config, wakeOnMessage: { enabled: true } }));
    await doc.save();
    expect((await raw(a)).runtimeIdentityAt.toISOString()).toBe('2020-01-20T00:00:00.000Z');
    expect((await runtimeIn(b)).runtimeType).toBe('claude-code');
  });

  it('changing an install\'s identity, or reactivating it, makes it the newest', async () => {
    const a = await install(podA, { runtimeType: 'webhook', host: 'byo', adapter: 'codex' });
    const b = await install(podB, { runtimeType: 'claude-code', host: 'byo' });
    await stamp(a, '2020-01-20T00:00:00Z');
    await stamp(b, '2020-01-25T00:00:00Z');
    const doc = await AgentInstallation.findById(a._id);
    doc.config = new Map(Object.entries({ runtime: { runtimeType: 'codex', host: 'byo' } }));
    await doc.save();
    expect((await runtimeIn(b)).runtimeType).toBe('codex');

    // b starts older than a, so only the reactivation stamp can make it win.
    await stamp(a, '2020-01-20T00:00:00Z');
    await stamp(b, '2020-01-10T00:00:00Z');
    expect((await runtimeIn(a)).runtimeType).toBe('codex');
    await AgentInstallation.updateOne({ _id: b._id }, { $set: { status: 'uninstalled' } });
    const back = await AgentInstallation.findById(b._id);
    back.status = 'active';
    await back.save();
    expect((await runtimeIn(a)).runtimeType).toBe('claude-code');
  });

  it('stamps the clock when an install is created with an identity, and not without one', async () => {
    const declared = await install(podA, { runtimeType: 'claude-code', host: 'byo' });
    const bare = await install(podB, null);
    expect((await raw(declared)).runtimeIdentityAt).toBeInstanceOf(Date);
    expect((await raw(bare)).runtimeIdentityAt).toBeUndefined();
  });

  it('a stamped install beats rows from before the clock, which fall back to creation order', async () => {
    const legacyOld = await install(podA, { runtimeType: 'codex', host: 'byo' });
    const legacyNew = await install(podB, { runtimeType: 'webhook', host: 'byo', adapter: 'codex' });
    await AgentInstallation.collection.updateMany({}, { $unset: { runtimeIdentityAt: '' } });
    await AgentInstallation.collection.updateOne({ _id: legacyOld._id }, { $set: { createdAt: new Date('2026-09-01T00:00:00Z') } });
    await AgentInstallation.collection.updateOne({ _id: legacyNew._id }, { $set: { createdAt: new Date('2026-09-02T00:00:00Z') } });
    expect((await runtimeIn(legacyOld)).adapter).toBe('codex');
    expect((await runtimeIn(legacyOld)).runtimeType).toBe('webhook');
    const attached = await install(podC, { runtimeType: 'claude-code', host: 'byo' });
    await AgentInstallation.collection.updateOne({ _id: attached._id }, { $set: { createdAt: new Date('2026-08-01T00:00:00Z') } });
    expect((await runtimeIn(legacyNew)).runtimeType).toBe('claude-code');
  });

  it('a re-attach through upsert onto an existing row makes it the newest', async () => {
    const a = await install(podA, { runtimeType: 'claude-code', host: 'byo' });
    const b = await install(podB, { runtimeType: 'webhook', host: 'byo', adapter: 'codex' });
    await stamp(a, '2020-01-20T00:00:00Z');
    await stamp(b, '2020-01-25T00:00:00Z');
    await AgentInstallation.upsert('sprint-review', podA, {
      version: '1.0.0', installedBy: owner, config: { runtime: { runtimeType: 'claude-code', host: 'byo' } },
    });
    expect((await runtimeIn(a)).runtimeType).toBe('claude-code');
    expect((await runtimeIn(b)).runtimeType).toBe('claude-code');
  });

  it('an upsert with no runtime (mention auto-join) leaves the clock alone', async () => {
    const a = await install(podA, { runtimeType: 'claude-code', host: 'byo' });
    await stamp(a, '2020-01-20T00:00:00Z');
    await AgentInstallation.upsert('sprint-review', podB, {
      version: '1.0.0', installedBy: owner, config: { heartbeat: { enabled: false }, autoJoinSource: 'mention-resolution' },
    });
    const joined = await AgentInstallation.findOne({ podId: podB }).lean();
    expect(joined.runtimeIdentityAt).toBeUndefined();
    expect((await runtimeIn(joined)).runtimeType).toBe('claude-code');
  });
});
