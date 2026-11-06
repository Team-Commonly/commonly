// Which writes change `installedBy` when a row comes back. A person installing
// asks for it; everything else that reactivates a row leaves the name alone.
const { Types } = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { takeBackInstallation } = require('../../services/runtimeIdentityOwnership');

jest.setTimeout(60000);

describe('reactivating an installation', () => {
  const key = { agentName: 'reactivated', instanceId: 'default' };
  const original = new Types.ObjectId();
  const caller = new Types.ObjectId();
  const podId = new Types.ObjectId();
  const options = (extra = {}) => ({
    version: '1.0.0', config: {}, scopes: [], installedBy: caller, instanceId: 'default', ...extra,
  });
  const seed = (status) => AgentInstallation.collection.insertOne({
    ...key, podId, installedBy: original, status, version: '1.0.0', config: {},
  });
  const stored = () => AgentInstallation.findOne({ ...key, podId }).lean();

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(() => AgentInstallation.deleteMany({}));

  it('stamps the caller when the install says a person is reinstalling', async () => {
    await seed('uninstalled');
    await AgentInstallation.install(key.agentName, podId, options({ stampInstaller: true }));
    expect(await stored()).toMatchObject({ status: 'active', installedBy: caller });
  });

  it('keeps the installer of a row that was not uninstalled, even when asked', async () => {
    await seed('paused');
    await AgentInstallation.install(key.agentName, podId, options({ stampInstaller: true }));
    expect(await stored()).toMatchObject({ status: 'active', installedBy: original });
  });

  it('keeps the installer for a caller that did not ask, such as an auto-join', async () => {
    await seed('uninstalled');
    await AgentInstallation.install(key.agentName, podId, options());
    expect(await stored()).toMatchObject({ status: 'active', installedBy: original });
  });

  it('keeps the installer through the idempotent upsert a mention uses', async () => {
    await seed('uninstalled');
    await AgentInstallation.upsert(key.agentName, podId, options());
    expect(await stored()).toMatchObject({ status: 'active', installedBy: original });
  });

  it('puts the installer back when the install is taken back', async () => {
    await seed('uninstalled');
    const previous = await AgentInstallation.findOne({ ...key, podId });
    await AgentInstallation.install(key.agentName, podId, options({ stampInstaller: true }));
    await takeBackInstallation({ ...key, podId }, previous);
    expect(await stored()).toMatchObject({ status: 'uninstalled', installedBy: original });
  });
});
