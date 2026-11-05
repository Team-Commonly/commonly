/**
 * An index that won't build must not stop the boot seed. When syncIndexes()
 * rejects for one model, the connectors and the other models' indexes still
 * have to land.
 */
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../models/InstallableInstallation', () => ({
  collection: { indexes: jest.fn().mockResolvedValue([]), dropIndex: jest.fn() },
  syncIndexes: jest.fn(),
}));
jest.mock('../../../models/ConnectorSecret', () => ({ syncIndexes: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/WebhookDelivery', () => ({ syncIndexes: jest.fn().mockResolvedValue([]) }));

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const WebhookDelivery = require('../../../models/WebhookDelivery');
const { seedBuiltinConnectors } = require('../../../scripts/seed-builtin-connectors');

describe('builtin connector seed when an index build fails', () => {
  it('still seeds both connectors and builds the other models\' indexes', async () => {
    InstallableInstallation.syncIndexes.mockRejectedValueOnce(
      new Error('E11000 duplicate key error collection: commonly.installableinstallations'),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await seedBuiltinConnectors();

      expect(ConnectorSecret.syncIndexes).toHaveBeenCalled();
      expect(WebhookDelivery.syncIndexes).toHaveBeenCalled();
      expect(Installable.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[builtin-connectors]'), expect.any(String));
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
