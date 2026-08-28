const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let Machine;
let AgentCredential;
let machineService;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Machine = require('../../../models/Machine');
  AgentCredential = require('../../../models/AgentCredential');
  machineService = require('../../../services/machineService');
});

afterEach(async () => {
  await Promise.all([
    Machine.deleteMany({}),
    AgentCredential.deleteMany({}),
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
    expect(machine.status).toBe('online');
    expect(token).toMatch(/^cm_daemon_/);
    const credential = await AgentCredential.findOne({ machineId: machine.machineId }).lean();
    expect(credential).toEqual(expect.objectContaining({
      kind: 'daemon',
      ownerUserId,
      scopes: expect.arrayContaining(['machine:heartbeat', 'agent:adopt', 'agent:runtime-token:mint']),
    }));
    expect(credential.tokenHash).not.toContain(token);
  });

  it('refuses a daemon heartbeat for another machine', async () => {
    const ownerUserId = new mongoose.Types.ObjectId();
    const first = await machineService.registerMachine({ ownerUserId, name: 'First Mac' });
    const second = await machineService.registerMachine({ ownerUserId, name: 'Second Mac' });
    const secondCredential = await AgentCredential.findOne({ machineId: second.machine.machineId }).lean();

    const result = await machineService.recordMachineHeartbeat({
      machineDbId: first.machine.id,
      credential: secondCredential,
    });

    expect(result).toEqual({ machine: null, authorized: false });
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

    expect(await machineService.removeMachine({
      machineDbId: machine.id,
      actorUserId: String(ownerUserId),
      isAdmin: false,
    })).toBe('removed');

    expect(await Machine.findById(machine.id)).toBeNull();
    expect((await AgentCredential.findById(daemon._id)).status).toBe('revoked');
    expect((await AgentCredential.findById(child._id)).status).toBe('revoked');
  });
});
