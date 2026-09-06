const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let Machine;
let AgentCredential;
let User;
let machineService;

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
