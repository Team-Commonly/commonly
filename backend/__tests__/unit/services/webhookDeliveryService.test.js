jest.mock('../../../models/WebhookDelivery', () => ({
  create: jest.fn(),
  deleteOne: jest.fn(),
}));

const WebhookDelivery = require('../../../models/WebhookDelivery');
const {
  WEBHOOK_DELIVERY_TTL_MS,
  claimDelivery,
  releaseDelivery,
} = require('../../../services/webhookDeliveryService');

describe('shared webhook delivery claim gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    WebhookDelivery.create.mockResolvedValue({});
    WebhookDelivery.deleteOne.mockResolvedValue({});
  });

  test('creates a namespaced claim with the configured TTL', async () => {
    const before = Date.now();
    expect(await claimDelivery('slack', 'T1:Ev1')).toBe('claimed');
    const claim = WebhookDelivery.create.mock.calls[0][0];
    expect(claim.provider).toBe('slack');
    expect(claim.deliveryId).toBe('T1:Ev1');
    expect(claim.expiresAt.getTime()).toBeGreaterThanOrEqual(before + WEBHOOK_DELIVERY_TTL_MS);
  });

  test('maps the unique-index race to duplicate', async () => {
    WebhookDelivery.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));
    expect(await claimDelivery('discord', 'webhook:event')).toBe('duplicate');
  });

  test('reports store unavailability so routes can retry', async () => {
    WebhookDelivery.create.mockRejectedValueOnce(new Error('mongo down'));
    expect(await claimDelivery('groupme', 'bot:message')).toBe('unavailable');
  });

  test('releases a provider claim by the same compound key', async () => {
    await releaseDelivery('telegram', '42');
    expect(WebhookDelivery.deleteOne).toHaveBeenCalledWith({ provider: 'telegram', deliveryId: '42' });
  });
});
