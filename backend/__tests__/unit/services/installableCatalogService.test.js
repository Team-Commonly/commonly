jest.mock('../../../models/Installable', () => ({ find: jest.fn() }));
jest.mock('../../../models/InstallableInstallation', () => ({ find: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn() }));
jest.mock('../../../integrations/manifests', () => ({
  manifests: {
    telegram: { id: 'telegram', readiness: jest.fn(() => ({ available: true })) },
    slack: { id: 'slack', readiness: jest.fn(() => ({ available: false, reason: 'not_configured' })) },
  },
}));

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const { catalogFor } = require('../../../services/installable/installableCatalogService');

const userId = '64b64c48c4f37a6b2f34c111';
const installationId = '64b64c48c4f37a6b2f34c222';
const podId = '64b64c48c4f37a6b2f34c333';
const lean = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe('installable catalog service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns provider readiness and the caller parent without leaking private fields', async () => {
    Installable.find.mockReturnValue(lean([
      { installableId: 'telegram', name: 'Telegram', description: 'Telegram description' },
      { installableId: 'slack', name: 'Slack', description: 'Slack description' },
    ]));
    InstallableInstallation.find.mockReturnValue(lean([{
      _id: installationId,
      installableId: 'telegram',
      status: 'error',
      errorMessage: 'projection missing',
      targetId: 'another-user',
      installedBy: 'another-user',
      claimId: 'private-claim',
      boundPodId: podId,
      claimedAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:01:00.000Z',
      components: [{ componentName: 'telegram-webhook', status: 'stale' }],
    }]));
    Integration.find.mockReturnValue(lean([{
      installationId,
      type: 'telegram',
      config: { botTokenRef: 'secret-ref', oauthStateNonce: 'nonce', chatTitle: 'Ops' },
    }]));

    const catalog = await catalogFor(userId);

    expect(catalog.installables).toEqual([
      expect.objectContaining({
        installableId: 'telegram',
        available: true,
        installation: {
          status: 'error',
          errorMessage: 'projection missing',
          boundPodId: podId,
          claimedAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:01:00.000Z',
          components: [{ name: 'telegram-webhook', status: 'stale' }],
        },
        integration: expect.objectContaining({
          installationId,
          config: { chatTitle: 'Ops' },
        }),
      }),
      expect.objectContaining({
        installableId: 'slack',
        available: false,
        unavailableReason: 'not_configured',
        installation: null,
        integration: null,
      }),
    ]);
    expect(InstallableInstallation.find).toHaveBeenCalledWith(expect.objectContaining({ targetId: userId }));
    expect(JSON.stringify(catalog)).not.toMatch(/SLACK_|CONNECTOR_SECRET|private-claim|secret-ref|nonce/);
  });

  it('does not read projections when the caller has no live parent', async () => {
    Installable.find.mockReturnValue(lean([]));
    InstallableInstallation.find.mockReturnValue(lean([]));

    const catalog = await catalogFor(userId);

    expect(catalog.installables).toHaveLength(2);
    expect(Integration.find).not.toHaveBeenCalled();
  });
});
