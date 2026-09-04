import type { ISlackEventReceipt } from '../models/SlackEventReceipt';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const SlackEventReceipt = require('../models/SlackEventReceipt');

export const EVENT_CLAIM_TTL_MS = 10_000;

export type SlackEventClaim = 'claimed' | 'duplicate_done' | 'duplicate_processing';

export const claim = async (
  eventId: string,
  teamId: string,
  now: Date = new Date(),
): Promise<SlackEventClaim> => {
  try {
    await SlackEventReceipt.create({
      eventId,
      teamId,
      state: 'processing',
      claimedAt: now,
      receivedAt: now,
    });
    return 'claimed';
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }

  const existing = await SlackEventReceipt.findOne({ eventId }) as ISlackEventReceipt | null;
  if (!existing || existing.state === 'done') return 'duplicate_done';
  const staleBefore = new Date(now.getTime() - EVENT_CLAIM_TTL_MS);
  if (existing.claimedAt > staleBefore) return 'duplicate_processing';
  const recovered = await SlackEventReceipt.findOneAndUpdate(
    { eventId, state: 'processing', claimedAt: { $lte: staleBefore } },
    { $set: { claimedAt: now } },
    { new: true },
  );
  return recovered ? 'claimed' : 'duplicate_processing';
};

export const markDone = async (eventId: string): Promise<void> => {
  await SlackEventReceipt.updateOne({ eventId, state: 'processing' }, { $set: { state: 'done' } });
};

module.exports = { EVENT_CLAIM_TTL_MS, claim, markDone };
