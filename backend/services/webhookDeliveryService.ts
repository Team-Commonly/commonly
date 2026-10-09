// Shared claim-before-run gate for provider webhook deliveries.
// The model's unique { provider, deliveryId } index is the cross-replica
// atomicity boundary; this service only supplies the common TTL/error policy.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const WebhookDelivery = require('../models/WebhookDelivery');

export const WEBHOOK_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

export type WebhookDeliveryClaim = 'claimed' | 'duplicate' | 'unavailable';

export const claimDelivery = async (
  provider: string,
  deliveryId: string,
  ttlMs = WEBHOOK_DELIVERY_TTL_MS,
): Promise<WebhookDeliveryClaim> => {
  try {
    await WebhookDelivery.create({
      provider,
      deliveryId,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return 'claimed';
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return 'duplicate';
    // Let each route choose its outage policy. Telegram preserves its legacy
    // fail-open behavior; HTTP webhook routes return 503 so the provider
    // retries instead of silently losing an already-acknowledged delivery.
    console.error(`[${provider}-webhook] delivery claim unavailable`, {
      deliveryId,
      error: (error as Error).message,
    });
    return 'unavailable';
  }
};

export const releaseDelivery = async (
  provider: string,
  deliveryId: string,
): Promise<void> => {
  try {
    await WebhookDelivery.deleteOne({ provider, deliveryId });
  } catch (error) {
    console.error(`[${provider}-webhook] delivery release failed`, {
      deliveryId,
      error: (error as Error).message,
    });
  }
};

module.exports = {
  WEBHOOK_DELIVERY_TTL_MS,
  claimDelivery,
  releaseDelivery,
};
