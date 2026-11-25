const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let Machine;
let AgentCredential;
let User;
let machineService;

// The real payload a daemon sends per seat, from
// cli/src/lib/daemon-supervisor.js:73-85 agentStates(): ten fields, six of which
// the server does not store.
const fullSeatReport = {
  agentName: 'Kai',
  instanceId: 'default',
  state: 'running',
  restarts: 1,
  adapter: 'claude',
  model: 'sonnet',
  effort: 'high',
  pid: 4242,
  lastTurnAt: '2026-09-18T19:00:00.000Z',
  lastError: null,
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Machine = require('../../../models/Machine');
  AgentCredential = require('../../../models/AgentCredential');
  User = require('../../../models/User');
  machineService = require('../../../services/machineService');
});

afterEach(async () => {
  await Promise.all([
    Machine.deleteMany({}),
    AgentCredential.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('ADR-026 machine lifecycle service', () => {
  it('registers a machine with a server id and returns the daemon bearer only once', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();

    const { machine, token } = await machineService.registerMachine({
      ownerUserId,
      name: 'Sam’s MacBook',
    });

    expect(machine.machineId).toMatch(/^[\da-f-]{36}$/i);
    expect(machine.status).toBe('offline');
    expect(machine.lastSeenAt).toBeNull();
    expect(token).toMatch(/^cm_daemon_/);
    const credential = await AgentCredential.findOne({ machineId: machine.machineId }).lean();
    expect(credential).toEqual(expect.objectContaining({
      kind: 'daemon',
      ownerUserId,
      scopes: ['machine:heartbeat', 'machine:read', 'agents:adopt'],
    }));
    expect(credential.tokenHash).not.toContain(token);
    expect(credential.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('stamps the credential-derived machine on heartbeat', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const first = await machineService.registerMachine({ ownerUserId, name: 'First Mac' });
    const persisted = await Machine.findById(first.machine.id);
    expect(persisted).toBeTruthy();
    const result = await machineService.recordMachineHeartbeat(persisted);

    expect(result.status).toBe('online');
    expect(result.lastSeenAt).toBeInstanceOf(Date);
  });

  it('stores reported agent states wholesale, drops malformed entries, and preserves the last report when the array is absent', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Agent Mac' });
    const persisted = await Machine.findById(machine.id);

    const reported = await machineService.recordMachineHeartbeat(persisted, [
      { agentName: 'Wren-Test', state: 'running', restarts: 2 },
      { agentName: 'kai-test', instanceId: 'ci', state: 'crashed', restarts: -3 },
      { agentName: '', state: 'running' },
      { agentName: 'bad-state', state: 'sleeping' },
    ]);
    expect(reported.agentStates).toEqual([
      { agentName: 'wren-test', instanceId: 'default', state: 'running', restarts: 2 },
      { agentName: 'kai-test', instanceId: 'ci', state: 'crashed', restarts: 0 },
    ]);

    // A Phase-1 daemon that reports no array must not erase the last report.
    const unchanged = await machineService.recordMachineHeartbeat(await Machine.findById(machine.id));
    expect(unchanged.agentStates).toHaveLength(2);

    // An explicit empty array IS a report: nothing is supervised any more.
    const cleared = await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), []);
    expect(cleared.agentStates).toEqual([]);
  });

  it('two overlapping heartbeats from one machine both succeed; the last write wins (F623)', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Busy Mac' });
    // The route's shape: each request loads its own copy before either writes.
    const first = await Machine.findById(machine.id);
    const second = await Machine.findById(machine.id);

    const a = await machineService.recordMachineHeartbeat(first, [
      { agentName: 'kai', state: 'running', restarts: 1 },
    ]);
    const b = await machineService.recordMachineHeartbeat(second, [
      { agentName: 'wren', state: 'crashed', restarts: 2 },
    ]);

    expect(a.status).toBe('online');
    expect(b.agentStates).toEqual([{ agentName: 'wren', instanceId: 'default', state: 'crashed', restarts: 2 }]);
    const stored = await Machine.findById(machine.id).lean();
    expect(stored.agentStates.map((s) => s.agentName)).toEqual(['wren']);
  });

  it('a machine deleted after the route read answers null instead of throwing (F623)', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Gone Mac' });
    const loaded = await Machine.findById(machine.id);
    await Machine.deleteOne({ _id: machine.id });

    await expect(machineService.recordMachineHeartbeat(loaded, [])).resolves.toBeNull();
    expect(await Machine.countDocuments({})).toBe(0);
  });

  it('keeps a standing inventory when a heartbeat carries none, and replaces it when one does (F623)', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Inventory Mac' });
    const row = { harness: 'claude', installed: true, version: '2.1', models: null, efforts: ['high'] };

    await machineService.recordMachineHeartbeat(await Machine.findById(machine.id));
    expect((await Machine.findById(machine.id).lean()).inventoryAt || null).toBeNull();

    await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), undefined, [row]);
    const withInv = await Machine.findById(machine.id).lean();
    expect(withInv.inventoryAt).toBeInstanceOf(Date);
    expect(withInv.runtimeInventory).toHaveLength(1);

    await machineService.recordMachineHeartbeat(await Machine.findById(machine.id));
    const kept = await Machine.findById(machine.id).lean();
    expect(kept.inventoryAt).toEqual(withInv.inventoryAt);
    expect(kept.runtimeInventory).toHaveLength(1);
  });

  it('records the host sandbox report, and a heartbeat that carries none leaves it standing', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Windows PC' });
    expect((await machineService.recordMachineHeartbeat(await Machine.findById(machine.id))).hostUnconfined).toBe(false);

    const opted = await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), [], undefined, 'unsandboxed-opted-in');
    expect(opted.hostUnconfined).toBe(true);
    // An older daemon (or a malformed value) says nothing; it does not clear the report.
    for (const value of [undefined, null, '', 'nope', true]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), [], undefined, value)).hostUnconfined).toBe(true);
    }
    // A Windows daemon without the opt-in still has no OS sandbox (Codex, or a removed marker).
    await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), [], undefined, 'default');
    expect((await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), [], undefined, 'native-windows')).hostUnconfined).toBe(true);
    const cleared = await machineService.recordMachineHeartbeat(await Machine.findById(machine.id), [], undefined, 'default');
    expect(cleared.hostUnconfined).toBe(false);
  });

  it('keeps only the four stored seat fields when a daemon reports its full payload', () => {
    // FILTER 1 of 2. This pins the rebuild in normalizeAgentStates
    // (backend/services/machineService.ts:28-47). Do not move this assertion up
    // to recordMachineHeartbeat or serializeMachine: the schema drops the same
    // six paths, so under a spread here neither of those surfaces changes, and
    // this layer is the only one that can fail. Filter 2 is the next test.
    const normalized = machineService.normalizeAgentStates([fullSeatReport]);

    expect(normalized).toEqual([
      {
        agentName: 'kai', instanceId: 'default', state: 'running', restarts: 1,
      },
    ]);
  });

  it('drops undeclared seat paths at the schema too, without normalizeAgentStates', async () => {
    // FILTER 2 of 2. Writes the ten-field entry straight through the model, so
    // filter 1 never runs. Machine.ts declares four paths and sets no `strict`
    // option, so Mongoose's default strips the rest (the subdoc has `_id: false`).
    // Without this test, adding a declared `adapter` path or `strict: false`
    // passes the whole suite, because filter 1 removes the field first.
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Schema Mac' });

    await Machine.updateOne(
      { _id: machine.id },
      { $set: { agentStates: [fullSeatReport] } },
    );

    const raw = await mongoose.connection
      .collection('machines')
      .findOne({ _id: new mongoose.Types.ObjectId(machine.id) });
    expect(Object.keys(raw.agentStates[0]).sort()).toEqual(
      ['agentName', 'instanceId', 'restarts', 'state'],
    );
  });

  it('lists an owner’s computers with the createdAt the database stored, so a picker can date a shared name', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const saved = await Machine.create({ ownerUserId, machineId: 'mach-round-trip', name: 'Sams-MacBook' });

    const { machines } = await machineService.listMachinesForOwner(ownerUserId);

    expect(machines).toEqual([expect.objectContaining({ machineId: 'mach-round-trip', createdAt: saved.createdAt })]);
  });

  it('returns only the credential-bound machine for daemon status', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const first = await machineService.registerMachine({ ownerUserId, name: 'First Mac' });
    const second = await machineService.registerMachine({ ownerUserId, name: 'Second Mac' });

    await expect(machineService.getMachineForDaemon({
      machineId: first.machine.machineId,
      ownerUserId,
    })).resolves.toMatchObject({ id: first.machine.id, name: 'First Mac' });
    await expect(machineService.getMachineForDaemon({
      machineId: second.machine.machineId,
      ownerUserId: new mongoose.Types.ObjectId(),
    })).resolves.toBeNull();
  });

  it('cascade-revokes the daemon’s descendants before removing its row', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const { machine } = await machineService.registerMachine({ ownerUserId, name: 'Sam’s Mac' });
    const daemon = await AgentCredential.findOne({ machineId: machine.machineId });
    const child = await AgentCredential.create({
      tokenHash: `runtime-${Date.now()}`,
      kind: 'runtime',
      ownerUserId,
      parentId: daemon._id,
      machineId: machine.machineId,
      scopes: [],
    });
    // Cleanup must still find a legacy/incompletely-revoked daemon row: its
    // child can otherwise keep a machine's authority after removal.
    await AgentCredential.updateOne({ _id: daemon._id }, { $set: { status: 'revoked' } });
    const agent = await User.create({
      username: `agent-${Date.now()}`,
      email: `agent-${Date.now()}@example.test`,
      password: 'x'.repeat(12),
      isBot: true,
      botMetadata: {},
    });
    await User.updateOne(
      { _id: agent._id },
      { $set: { 'botMetadata.machineId': machine.machineId } },
      { strict: false },
    );

    expect(await machineService.removeMachine({
      machineDbId: machine.id,
      actorUserId: String(ownerUserId),
      isAdmin: false,
    })).toBe('removed');

    expect(await Machine.findById(machine.id)).toBeNull();
    expect((await AgentCredential.findById(daemon._id)).status).toBe('revoked');
    expect((await AgentCredential.findById(child._id)).status).toBe('revoked');
    expect((await User.findById(agent._id).lean()).botMetadata.machineId).toBeNull();
  });
});
