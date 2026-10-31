/**
 * TASK-697: the staging seed is idempotent and complete, and its guard refuses
 * anything that is not staging. Mongo is MongoMemoryServer; Postgres is pg-mem
 * built from the SHIPPED schema.sql (applyTable), so ON CONFLICT targets and
 * the thread_root_id / payload columns are the production DDL, not a fixture.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { applyTable } = require('../../utils/schemaTable');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const AgentMemory = require('../../../models/AgentMemory');
const Integration = require('../../../models/Integration');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { validateAgentCardPayload } = require('../../../services/uiCardValidation');
const KernelWorkSweepService = require('../../../services/kernelWorkSweepService');
const { findHostedMcpEntry, HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { runStagingSeed } = require('../../../scripts/staging-seed/seed');
const { main } = require('../../../scripts/staging-seed');
const {
  assertCredOutOutsideRepo, assertStagingTarget, StagingGuardError,
} = require('../../../scripts/staging-seed/guard');
const {
  AGENTS, AVAILABLE_HOSTED_ENTRY, CONNECTED_HOSTED_ENTRY, POD, SEAT, seedObjectId,
} = require('../../../scripts/staging-seed/fixtures');

describe('staging seed', () => {
  let pool;
  let tmp;
  let credOut;

  beforeAll(async () => {
    await setupMongoDb();
    const db = newDb();
    pool = new (db.adapters.createPg().Pool)();
    for (const table of ['pods', 'pod_members', 'users', 'messages']) {
      // eslint-disable-next-line no-await-in-loop
      await applyTable(pool, table);
    }
    // Never the operator's real credential store (AX audit: a default root once
    // made a test write into ~/.commonly/credentials).
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-seed-'));
    credOut = path.join(tmp, 'nested', 'seat.json');
  });

  afterAll(async () => {
    await closeMongoDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const counts = async () => {
    const pg = async (table) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    return {
      users: await User.countDocuments({}),
      pods: await Pod.countDocuments({}),
      installations: await AgentInstallation.countDocuments({}),
      tasks: await Task.countDocuments({}),
      memory: await AgentMemory.countDocuments({}),
      connectors: await Integration.countDocuments({}),
      pgUsers: await pg('users'),
      pgPods: await pg('pods'),
      pgMembers: await pg('pod_members'),
      messages: await pg('messages'),
    };
  };

  it('writes everything once, then a second run changes nothing', async () => {
    const first = await runStagingSeed({ pool, credOut });
    expect(first.seatPassword).toBe('created');
    const afterFirst = await counts();
    const credBefore = fs.readFileSync(credOut, 'utf8');
    const seatBefore = await User.findById(seedObjectId(SEAT.key)).lean();

    const second = await runStagingSeed({ pool, credOut });
    expect(await counts()).toEqual(afterFirst);
    for (const tally of Object.values(second.mongo)) expect(tally).toEqual({ upserted: 0, modified: 0 });
    expect(second.pg).toEqual({ users: 0, pods: 0, members: 0, messages: 0 });
    expect(second.seatPassword).toBe('unchanged');
    expect(fs.readFileSync(credOut, 'utf8')).toBe(credBefore);
    expect((await User.findById(seedObjectId(SEAT.key)).lean()).password).toBe(seatBefore.password);

    expect(afterFirst).toMatchObject({ users: 7, pods: 1, installations: 4, tasks: 13, memory: 2, connectors: 1, pgPods: 1, pgMembers: 7 });
  });

  it('builds an invite-only pod with 4+ named agents, each installed, and 2+ humans', async () => {
    const pod = await Pod.findById(seedObjectId(POD.key)).lean();
    expect(pod).toMatchObject({ name: 'D215 sample', joinPolicy: 'invite-only', publicRead: false, communityListed: false });
    const members = await User.find({ _id: { $in: pod.members } }).lean();
    const agents = members.filter((m) => m.isBot);
    const humans = members.filter((m) => !m.isBot);
    expect(agents.length).toBeGreaterThanOrEqual(4);
    expect(humans.length).toBeGreaterThanOrEqual(2);
    agents.forEach((agent) => {
      expect(agent.botMetadata.displayName).toBeTruthy();
      expect(agent.botMetadata.description).toBeTruthy();
    });
    expect(new Set(agents.map((a) => `${a.botMetadata.agentName}:${a.botMetadata.instanceId}`)).size).toBe(agents.length);
    const installs = await AgentInstallation.find({ podId: pod._id, status: 'active' }).lean();
    expect(installs.map((i) => i.instanceId).sort()).toEqual(AGENTS.map((a) => a.instanceId).sort());
    expect(pod.members.map(String)).toContain(String(pod.createdBy));
  });

  it('fills the board: 3+ rows per status, assignees, a dep and a done row with a prUrl', async () => {
    const tasks = await Task.find({ podId: seedObjectId(POD.key) }).lean();
    for (const status of ['pending', 'claimed', 'blocked', 'done']) {
      expect(tasks.filter((t) => t.status === status).length).toBeGreaterThanOrEqual(3);
    }
    expect(tasks.every((t) => t.assignee)).toBe(true);
    const withDep = tasks.find((t) => t.dep);
    expect(tasks.map((t) => t.taskId)).toContain(withDep.dep);
    expect(tasks.find((t) => t.status === 'done' && t.prUrl).prUrl).toMatch(/^https:\/\/github\.com\//);
    tasks.filter((t) => t.status === 'claimed').forEach((t) => expect(t.claimedBy).toMatch(/^[0-9a-f]{24}$/));
  });

  it('leaves no claimed row the lease sweep would hand back to pending', async () => {
    const podId = seedObjectId(POD.key);
    expect(await Task.countDocuments({ podId, status: 'claimed' })).toBeGreaterThanOrEqual(3);
    for (const at of [new Date(), new Date(Date.now() + 24 * 3600 * 1000)]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await Task.countDocuments({ podId, $or: KernelWorkSweepService.lapsedConditions(at) })).toBe(0);
    }
  });

  it('keeps members who joined through the UI across a re-run, and stays idempotent', async () => {
    const podId = seedObjectId(POD.key);
    const joiner = seedObjectId('test:ui-joiner');
    await Pod.updateOne({ _id: podId }, { $addToSet: { members: joiner } });
    const rerun = await runStagingSeed({ pool, credOut });
    expect(rerun.mongo.pods).toEqual({ upserted: 0, modified: 0 });
    const pod = await Pod.findById(podId).lean();
    expect(pod.members.map(String)).toContain(String(joiner));
    await Pod.updateOne({ _id: podId }, { $pull: { members: joiner } });
  });

  it('installs the agents as the seat, so its owner views have them', async () => {
    const installs = await AgentInstallation.find({ podId: seedObjectId(POD.key) }).lean();
    installs.forEach((i) => expect(String(i.installedBy)).toBe(String(seedObjectId(SEAT.key))));
  });

  it('writes long agent messages, a run of task-claimed lines, a valid ui card and a thread', async () => {
    const { rows } = await pool.query(
      `SELECT m.id, m.content, m.message_type, m.payload, m.thread_root_id, u.is_bot
         FROM messages m JOIN users u ON u._id = m.user_id
        WHERE m.pod_id = $1 ORDER BY m.created_at, m.id`,
      [String(seedObjectId(POD.key))],
    );
    const parse = (p) => (typeof p === 'string' ? JSON.parse(p) : p);
    expect(rows.filter((r) => r.is_bot && r.message_type === 'text' && r.content.length > 1500).length).toBeGreaterThanOrEqual(3);

    const isClaim = (r) => r.message_type === 'system' && parse(r.payload)?.kind === 'system-action' && parse(r.payload)?.action === 'task-claimed';
    let run = 0; let longest = 0;
    rows.forEach((r) => { run = isClaim(r) ? run + 1 : 0; longest = Math.max(longest, run); });
    expect(longest).toBeGreaterThanOrEqual(4);
    rows.filter(isClaim).forEach((r) => expect(r.content).toBe(`${parse(r.payload).actorName} claimed ${parse(r.payload).taskId}`));

    const card = rows.find((r) => r.message_type === 'card');
    expect(parse(card.payload)).toMatchObject({ kind: 'ui', v: 1, catalogId: 'commonly.ui', catalogRev: 1 });
    expect(() => validateAgentCardPayload('card', parse(card.payload), card.content)).not.toThrow();

    const replies = rows.filter((r) => r.thread_root_id != null);
    expect(replies.length).toBeGreaterThanOrEqual(3);
    const rootIds = new Set(replies.map((r) => String(r.thread_root_id)));
    expect(rootIds.size).toBe(1);
    expect(rows.map((r) => String(r.id))).toContain([...rootIds][0]);
    replies.forEach((r) => expect(r.content.length).toBeLessThan(200));
  });

  it('gives two agents memory and the seat one connected and one available connector', async () => {
    const memories = await AgentMemory.find({}).lean();
    expect(memories.length).toBeGreaterThanOrEqual(2);
    memories.forEach((m) => expect(m.sections.soul.content).toBeTruthy());

    const seat = await User.findById(seedObjectId(SEAT.key)).lean();
    expect(seat).toMatchObject({ username: 'd215-seat', role: 'user', isBot: false });
    const pod = await Pod.findById(seedObjectId(POD.key)).lean();
    expect(pod.members.map(String)).toContain(String(seat._id));

    const rowsForSeat = await Integration.find({ createdBy: seat._id }).lean();
    expect(rowsForSeat).toHaveLength(1);
    expect(rowsForSeat[0]).toMatchObject({ type: 'hosted-mcp', status: 'connected', scope: 'user' });
    expect(rowsForSeat[0].config.entryId).toBe(CONNECTED_HOSTED_ENTRY);
    expect(rowsForSeat[0].config.credentialRef).toBeUndefined();
    expect(rowsForSeat[0].config.refreshTokenRef).toBeUndefined();
    expect(AVAILABLE_HOSTED_ENTRY).not.toBe(CONNECTED_HOSTED_ENTRY);
    // Both names must be real catalogue entries, or the page shows neither.
    expect(findHostedMcpEntry(HOSTED_MCP_ENTRIES, CONNECTED_HOSTED_ENTRY)).toBeDefined();
    expect(findHostedMcpEntry(HOSTED_MCP_ENTRIES, AVAILABLE_HOSTED_ENTRY)).toBeDefined();
  });

  it('writes the seat password only to a 0600 file, and only rotates on request', async () => {
    const body = JSON.parse(fs.readFileSync(credOut, 'utf8'));
    expect(body).toMatchObject({ username: 'd215-seat', target: 'commonly-staging' });
    expect(fs.statSync(credOut).mode & 0o777).toBe(0o600);
    const seat = await User.findById(seedObjectId(SEAT.key));
    expect(await seat.comparePassword(body.password)).toBe(true);

    const rotated = await runStagingSeed({ pool, credOut, rotate: true });
    expect(rotated.seatPassword).toBe('rotated');
    const next = JSON.parse(fs.readFileSync(credOut, 'utf8'));
    expect(next.password).not.toBe(body.password);
    const after = await User.findById(seedObjectId(SEAT.key));
    expect(await after.comparePassword(next.password)).toBe(true);
    expect(after.tokenVersion).toBe((seat.tokenVersion || 0) + 1);
  });

  it('refuses a --cred-out inside a git checkout before writing anything', async () => {
    const repo = path.join(tmp, 'checkout');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const inside = path.join(repo, 'deep', 'seat.json');
    expect(() => assertCredOutOutsideRepo(inside)).toThrow(StagingGuardError);
    expect(() => assertCredOutOutsideRepo(path.join(tmp, 'elsewhere', 'seat.json'))).not.toThrow();
    // A worktree's .git is a file, and the real backend dir sits in one.
    expect(() => assertCredOutOutsideRepo(path.join(__dirname, 'seat.json'))).toThrow(/inside the git checkout/);
    const before = await User.findById(seedObjectId(SEAT.key)).lean();
    await expect(runStagingSeed({ pool, credOut: inside, rotate: true })).rejects.toThrow(StagingGuardError);
    expect(fs.existsSync(inside)).toBe(false);
    expect((await User.findById(seedObjectId(SEAT.key)).lean()).password).toBe(before.password);
  });

  describe('main()', () => {
    const stagingEnv = {
      MONGO_URI: 'mongodb://mongodb:27017/commonly',
      PG_HOST: 'pg.example.internal',
      PG_DATABASE: 'commonly_staging',
    };
    const deps = (overrides) => ({
      argv: ['--target=commonly-staging', `--cred-out=${credOut}`],
      env: stagingEnv,
      readNamespace: () => 'commonly-staging',
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
      loadPool: jest.fn(() => ({ query: (...args) => pool.query(...args) })),
      log: jest.fn(),
      ...overrides,
    });

    it.each([
      ['a prod namespace', { readNamespace: () => 'commonly-dev' }],
      ['an Atlas Mongo URI', { env: { ...stagingEnv, MONGO_URI: 'mongodb+srv://u:p@prod.example.mongodb.net/x' } }],
      ['the prod Postgres database', { env: { ...stagingEnv, PG_DATABASE: 'defaultdb' } }],
      ['no target', { argv: [`--cred-out=${credOut}`] }],
      ['a cred file inside this checkout', { argv: ['--target=commonly-staging', `--cred-out=${path.join(__dirname, 'x.json')}`] }],
    ])('refuses %s without connecting to anything', async (_name, override) => {
      const d = deps(override);
      await expect(main(d)).rejects.toThrow(StagingGuardError);
      expect(d.connect).not.toHaveBeenCalled();
      expect(d.loadPool).not.toHaveBeenCalled();
    });

    it('seeds on staging signals and never prints the password', async () => {
      const consoleLog = jest.spyOn(console, 'log');
      const d = deps({ argv: ['--target=commonly-staging', `--cred-out=${credOut}`, '--rotate'] });
      const report = await main(d);
      expect(report.seatPassword).toBe('rotated');
      expect(d.connect).toHaveBeenCalledWith(stagingEnv.MONGO_URI);
      const { password } = JSON.parse(fs.readFileSync(credOut, 'utf8'));
      const printed = [...d.log.mock.calls, ...consoleLog.mock.calls].flat().map(String);
      expect(printed.some((line) => line.includes('credentials written to'))).toBe(true);
      printed.forEach((line) => expect(line).not.toContain(password));
      consoleLog.mockRestore();
    });
  });
});

describe('staging seed guard', () => {
  const staging = {
    target: 'commonly-staging',
    namespace: 'commonly-staging',
    mongoUri: 'mongodb://root:pw@mongodb:27017/commonly?authSource=admin',
    pgHost: 'pg.example.internal',
    pgDatabase: 'commonly_staging',
  };
  const refused = (signals) => expect(() => assertStagingTarget({ ...staging, ...signals })).toThrow(StagingGuardError);

  it('accepts the staging signals, including the namespaced mongodb Service', () => {
    expect(() => assertStagingTarget(staging)).not.toThrow();
    expect(() => assertStagingTarget({ ...staging, mongoUri: 'mongodb://mongodb.commonly-staging.svc.cluster.local:27017/commonly' })).not.toThrow();
  });

  it('refuses when no target is given', () => {
    refused({ target: undefined });
    refused({ target: '' });
    expect(() => assertStagingTarget({})).toThrow(/no target/);
  });

  it('refuses a prod namespace, from the flag or from where it runs', () => {
    refused({ target: 'commonly-dev' });
    refused({ namespace: 'commonly-dev' });
    refused({ namespace: null });
  });

  it('refuses a prod Mongo host', () => {
    refused({ mongoUri: 'mongodb+srv://u:p@cluster0.example.mongodb.net/commonly' });
    refused({ mongoUri: 'mongodb://mongodb.commonly-dev.svc.cluster.local:27017/commonly' });
    refused({ mongoUri: 'mongodb://mongodb:27017,prod-shard.example.net:27017/commonly' });
    refused({ mongoUri: '' });
  });

  it('refuses a prod Postgres database or host', () => {
    refused({ pgDatabase: 'defaultdb' });
    refused({ pgDatabase: undefined });
    refused({ pgHost: 'postgres.commonly-dev.svc.cluster.local' });
    refused({ pgHost: '' });
  });

  it('never echoes Mongo credentials in a refusal', () => {
    expect(() => assertStagingTarget({ ...staging, mongoUri: 'mongodb://admin:s3cret@prod-host:27017/x' }))
      .toThrow(expect.objectContaining({ message: expect.not.stringContaining('s3cret') }));
  });
});
