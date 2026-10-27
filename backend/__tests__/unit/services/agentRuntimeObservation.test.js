const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
let mongo, Machine, User, Installation, Observation, recordRuntimeObservation, normalizeRuntimeInventory;
const owner = new mongoose.Types.ObjectId();
const agent = new mongoose.Types.ObjectId();
const machineId = 'test-machine';
const request = (body) => ({ body: { ...body, agentName: 'receipt-seat', instanceId: 'default' },
  machine: { ownerUserId: String(owner), machineId },
  agentUser: { _id: agent, botMetadata: { machineId } },
  agentCredential: { ownerUserId: owner, machineId, scopes: ['runtime'] } });
const response = () => ({ statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; } });
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Machine = require('../../../models/Machine');
  User = require('../../../models/User');
  Installation = require('../../../models/AgentRegistry').AgentInstallation;
  Observation = require('../../../models/AgentRuntimeObservation');
  ({ recordRuntimeObservation } = require('../../../services/agentRuntimeObservation'));
  ({ normalizeRuntimeInventory } = require('../../../services/runtimeInventory'));
});
beforeEach(async () => {
  await Promise.all([Machine.deleteMany({}), Observation.deleteMany({}), User.deleteMany({}), Installation.deleteMany({})]);
  await Machine.create({ ownerUserId: owner, machineId, name: 'test' });
  await User.create({ _id: agent, username: 'receipt-seat', email: 'receipt@test.invalid', password: 'pw', isBot: true,
    botMetadata: { agentName: 'receipt-seat', instanceId: 'default', machineId } });
  await Installation.create({ agentName: 'receipt-seat', instanceId: 'default', podId: new mongoose.Types.ObjectId(),
    version: '1', installedBy: owner, status: 'active', config: new Map([['runtime', { runtimeType: 'wrapper', adapter: 'codex' }]]) });
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
it('stores only an actual runner receipt and never claims runtime confirmation', async () => {
  const req = request({ event: 'connected' });
  await recordRuntimeObservation(req, response());
  let row = await Observation.findOne({ agentUserId: agent }).lean();
  expect(row.lastSpawn).toBeNull();
  req.body = { agentName: 'receipt-seat', event: 'spawn', harness: 'codex', version: '1.2', model: 'm', effort: 'high' };
  await recordRuntimeObservation(req, response());
  req.body = { agentName: 'receipt-seat', event: 'settled' };
  await recordRuntimeObservation(req, response());
  row = await Observation.findOne({ agentUserId: agent }).lean();
  expect(row.lastSpawn).toEqual(expect.objectContaining({ harness: 'codex', model: 'm', effort: 'high' }));
  expect(row.turnRunning).toBe(false);
  expect(row.lastTurnAt).toBeInstanceOf(Date);
  expect(row.confirmed).toBeUndefined();
});
it.each(['spawn-child', 'wrong-machine', 'wrong-owner', 'legacy-key'])('%s cannot forge runner observations', async (mode) => {
  const req = request({ event: 'connected' });
  if (mode === 'spawn-child') req.machine = null;
  if (mode === 'wrong-machine') req.machine.machineId = 'other';
  if (mode === 'wrong-owner') req.machine.ownerUserId = String(new mongoose.Types.ObjectId());
  if (mode === 'legacy-key') req.machine = null;
  const res = response();
  await recordRuntimeObservation(req, res);
  expect(res.statusCode).toBe(403);
  expect(await Observation.countDocuments()).toBe(0);
});
it('rejects extra fields instead of persisting caller argv/env/confirmation', async () => {
  const req = request({ event: 'spawn', harness: 'codex', version: '1', model: 'm', effort: null,
    argv: ['SECRET'], confirmed: { model: 'm' } });
  const res = response();
  await recordRuntimeObservation(req, res);
  expect(res.statusCode).toBe(400);
  expect(await Observation.countDocuments()).toBe(0);
});
it('normalizes only bounded walked inventory and excludes paths, raw output and secrets', () => {
  const result = normalizeRuntimeInventory([{ harness: 'codex', installed: true, version: '1.2',
    models: ['m', 'm'], efforts: ['high'], path: '/PRIVATE', env: { key: 'SECRET' } },
  { harness: 'unwalked', installed: true, models: ['secret'] }]);
  expect(result).toEqual([{ harness: 'codex', installed: true, version: '1.2', models: ['m'], efforts: ['high'] }]);
});
