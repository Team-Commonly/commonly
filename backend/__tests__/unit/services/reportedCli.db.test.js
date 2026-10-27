// TASK-317: recordReportedCli against the real AgentInstallation schema, where
// `config` is a Map of Mixed. The sibling suite mocks the model.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let AgentInstallation;
let recordReportedCli;
let resetReportedCliForTest;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  ({ AgentInstallation } = require('../../../models/AgentRegistry'));
  ({ recordReportedCli, resetReportedCliForTest } = require('../../../services/reportedCli'));
});
afterEach(async () => {
  resetReportedCliForTest();
  await AgentInstallation.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let seq = 0;
const install = (runtime) => {
  seq += 1;
  return AgentInstallation.create({
    agentName: `seat-${seq}`,
    podId: new mongoose.Types.ObjectId(),
    instanceId: 'default',
    version: '1.0.0',
    installedBy: new mongoose.Types.ObjectId(),
    config: { runtime },
  });
};
const runtimeOf = async (id) => {
  const row = await AgentInstallation.findById(id);
  return row.config.get('runtime') || {};
};
const until = async (check) => {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('recordReportedCli on the real schema', () => {
  test('a BYO seat with no adapter reads the label back through the model', async () => {
    const row = await install({ runtimeType: 'webhook', host: 'byo' });
    recordReportedCli([row._id], 'codex');
    await until(async () => (await runtimeOf(row._id)).reportedCli === 'codex');
    const runtime = await runtimeOf(row._id);
    expect(runtime).toEqual({ runtimeType: 'webhook', host: 'byo', reportedCli: 'codex' });
  });

  test('an explicit null adapter counts as unset', async () => {
    const row = await install({ runtimeType: 'webhook', host: 'byo', adapter: null });
    recordReportedCli([row._id], 'claude');
    await until(async () => (await runtimeOf(row._id)).reportedCli === 'claude');
    expect((await runtimeOf(row._id)).reportedCli).toBe('claude');
  });

  test('a declared adapter or a non-BYO host is left alone', async () => {
    const declared = await install({ runtimeType: 'webhook', host: 'byo', adapter: 'pi' });
    const hosted = await install({ runtimeType: 'webhook', host: 'hosted' });
    // Await the very write the service issued, then assert on the rows.
    const original = AgentInstallation.updateMany.bind(AgentInstallation);
    let issued;
    const write = jest.spyOn(AgentInstallation, 'updateMany').mockImplementation((...args) => {
      issued = original(...args).exec();
      return issued;
    });
    try {
      recordReportedCli([declared._id, hosted._id], 'claude');
      expect(write).toHaveBeenCalledTimes(1);
      expect((await issued).matchedCount).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect((await runtimeOf(declared._id)).reportedCli).toBeUndefined();
    expect((await runtimeOf(declared._id)).adapter).toBe('pi');
    expect((await runtimeOf(hosted._id)).reportedCli).toBeUndefined();
  });
});
