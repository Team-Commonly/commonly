// The production deps against the real User and AgentInstallation schemas. The
// sibling suite stubs the deps, so it cannot see a field the schema strips or a
// filter that does not match.
/* eslint-disable global-require */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let User;
let AgentInstallation;
let backfillListenerCheckIn;
let productionDeps;
let runBackfill;

const USED = new Date('2026-10-01T00:00:00Z');
const LISTENED = new Date('2026-10-30T00:00:00Z');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  User = require('../../../models/User');
  ({ AgentInstallation } = require('../../../models/AgentRegistry'));
  ({ backfillListenerCheckIn, productionDeps, runBackfill } = require('../../../scripts/backfill-listener-check-in'));
});
afterEach(async () => {
  await User.deleteMany({});
  await AgentInstallation.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const makeAgentUser = (tokens) => User.create({
  username: `bot${Math.floor(Math.random() * 1e9)}`,
  email: `bot${Math.floor(Math.random() * 1e9)}@agents.commonly.local`,
  password: 'x'.repeat(12),
  isBot: true,
  agentRuntimeTokens: tokens,
});

const makeInstall = (tokens) => AgentInstallation.collection.insertOne({
  agentName: 'a', instanceId: 'default', podId: new mongoose.Types.ObjectId(), status: 'active', runtimeTokens: tokens,
});

describe('backfill-listener-check-in against the real schemas', () => {
  it('stamps only used, unstamped tokens in both stores, and never touches a token hash', async () => {
    const user = await makeAgentUser([
      { tokenHash: 'secret-1', lastUsedAt: USED },
      { tokenHash: 'secret-2' },
      { tokenHash: 'secret-3', lastUsedAt: USED, lastListenedAt: LISTENED },
    ]);
    const inst = await makeInstall([
      { _id: new mongoose.Types.ObjectId(), tokenHash: 'secret-4', lastUsedAt: USED },
    ]);

    const deps = productionDeps();
    const { candidates: listed } = await deps.listCandidates();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('secret');

    const report = await backfillListenerCheckIn(deps, { apply: true, frozen: listed });
    expect(report).toMatchObject({ applied: 2, skippedAlreadyStamped: 0, failed: 0 });

    const after = await User.findById(user._id).lean();
    expect(after.agentRuntimeTokens[0].lastListenedAt).toEqual(USED);
    expect(after.agentRuntimeTokens[1].lastListenedAt).toBeUndefined();
    expect(after.agentRuntimeTokens[2].lastListenedAt).toEqual(LISTENED);
    const installAfter = await AgentInstallation.collection.findOne({ _id: inst.insertedId });
    expect(installAfter.runtimeTokens[0].lastListenedAt).toEqual(USED);
  });

  it('never overwrites a stamp a running listener wrote after the dry run', async () => {
    const user = await makeAgentUser([{ tokenHash: 'secret-1', lastUsedAt: USED }]);
    const deps = productionDeps();
    const { candidates: frozen } = await deps.listCandidates();
    await User.updateOne(
      { _id: user._id },
      { $set: { 'agentRuntimeTokens.0.lastListenedAt': LISTENED } },
    );
    const report = await backfillListenerCheckIn(deps, { apply: true, frozen });
    expect(report).toMatchObject({ applied: 0, skippedAlreadyStamped: 1 });
    const after = await User.findById(user._id).lean();
    expect(after.agentRuntimeTokens[0].lastListenedAt).toEqual(LISTENED);
  });

  it('is idempotent: a second apply of the same set changes nothing', async () => {
    await makeAgentUser([{ tokenHash: 'secret-1', lastUsedAt: USED }]);
    const deps = productionDeps();
    const { candidates: frozen } = await deps.listCandidates();
    await backfillListenerCheckIn(deps, { apply: true, frozen });
    const second = await backfillListenerCheckIn(deps, { apply: true, frozen });
    expect(second).toMatchObject({ applied: 0, skippedAlreadyStamped: 1 });
    expect((await deps.listCandidates()).candidates).toHaveLength(0);
  });

  it('stamps a token whose lastListenedAt is an explicit null', async () => {
    const inst = await makeInstall([
      {
        _id: new mongoose.Types.ObjectId(), tokenHash: 'secret-n', lastUsedAt: USED, lastListenedAt: null, 
      },
    ]);
    const deps = productionDeps();
    const { candidates } = await deps.listCandidates();
    expect(candidates).toHaveLength(1);
    const report = await backfillListenerCheckIn(deps, { apply: true, frozen: candidates });
    expect(report).toMatchObject({ applied: 1, skippedAlreadyStamped: 0 });
    const after = await AgentInstallation.collection.findOne({ _id: inst.insertedId });
    expect(after.runtimeTokens[0].lastListenedAt).toEqual(USED);
  });

  it('counts a token with no ObjectId _id as unaddressable instead of listing it', async () => {
    await makeInstall([
      { _id: 'not-an-object-id', tokenHash: 'secret-s', lastUsedAt: USED },
      // A 24-hex id stored as a string is still not an ObjectId and would never match.
      { _id: '0123456789abcdef01234567', tokenHash: 'secret-h', lastUsedAt: USED },
      { tokenHash: 'secret-m', lastUsedAt: USED },
    ]);
    const listing = await productionDeps().listCandidates();
    expect(listing.candidates).toHaveLength(0);
    expect(listing.unaddressable).toBe(3);
    expect(JSON.stringify(listing)).not.toContain('secret');
  });

  describe('runBackfill: the dry-run file handoff', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-backfill-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});

    it('freezes the set with --out and applies only that set with --ids', async () => {
      const log = quiet();
      const frozenUser = await makeAgentUser([{ tokenHash: 'secret-a', lastUsedAt: USED }]);
      const outPath = path.join(dir, 'ids.json');
      const dry = await runBackfill(productionDeps(), { apply: false, outPath });
      expect(dry).toMatchObject({ dryRun: true, candidates: 1, applied: 0 });
      const file = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(file.candidates).toHaveLength(1);
      expect(fs.readFileSync(outPath, 'utf8')).not.toContain('secret');
      expect((await User.findById(frozenUser._id).lean()).agentRuntimeTokens[0].lastListenedAt).toBeUndefined();

      // A token that becomes a candidate after the freeze is not part of it.
      const later = await makeAgentUser([{ tokenHash: 'secret-b', lastUsedAt: USED }]);
      const applied = await runBackfill(productionDeps(), { apply: true, idsPath: outPath });
      expect(applied).toMatchObject({ dryRun: false, frozen: 1, applied: 1 });
      expect((await User.findById(frozenUser._id).lean()).agentRuntimeTokens[0].lastListenedAt).toEqual(USED);
      expect((await User.findById(later._id).lean()).agentRuntimeTokens[0].lastListenedAt).toBeUndefined();
      log.mockRestore();
    });

    it('refuses --apply without --ids and writes nothing', async () => {
      const log = quiet();
      const user = await makeAgentUser([{ tokenHash: 'secret-a', lastUsedAt: USED }]);
      await expect(runBackfill(productionDeps(), { apply: true })).rejects.toThrow(/--ids/);
      expect((await User.findById(user._id).lean()).agentRuntimeTokens[0].lastListenedAt).toBeUndefined();
      log.mockRestore();
    });

    it('fails the run after trying the whole set when a stamp fails', async () => {
      const log = quiet();
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      await makeAgentUser([{ tokenHash: 'secret-a', lastUsedAt: USED }]);
      const idsPath = path.join(dir, 'ids.json');
      fs.writeFileSync(idsPath, JSON.stringify({
        candidates: [
          {
            store: 'user', ownerId: 'not-an-id', tokenId: 'nope', lastUsedAt: USED.toISOString(), 
          },
          ...(await productionDeps().listCandidates()).candidates,
        ],
      }));
      await expect(runBackfill(productionDeps(), { apply: true, idsPath })).rejects.toThrow(/1 token\(s\) failed/);
      // The good token after the bad one was still stamped.
      expect((await productionDeps().listCandidates()).candidates).toHaveLength(0);
      log.mockRestore();
      err.mockRestore();
    });
  });
});
