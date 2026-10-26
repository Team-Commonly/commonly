// TASK-569 (D55): attach writes a seat's runtime identity only onto the install
// where it ran, so the same seat showed a chip in one pod and none in another.
// Every pod now reads the seat's identity from its most recently written
// install, never the first match, so a harness swap shows everywhere.
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

// Rewrites updatedAt directly so the order of writes is explicit.
const stamp = (doc, iso) => AgentInstallation.collection.updateOne(
  { _id: doc._id }, { $set: { updatedAt: new Date(iso) } },
);

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
    await stamp(a, '2026-10-20T00:00:00Z');
    await stamp(b, '2026-10-25T00:00:00Z');
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
    await stamp(first, '2026-10-25T00:00:00Z');
    await stamp(second, '2026-10-21T00:00:00Z');
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
    await stamp(hosted, '2026-10-25T00:00:00Z');
    const runtime = await runtimeIn(bare);
    expect(runtime).toMatchObject({ runtimeType: 'hosted', host: 'cloud', model: 'm-2' });
  });
});
