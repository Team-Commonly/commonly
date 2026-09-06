import type {
  ChannelVerdictEventKind,
  ChannelVerdictKind,
  ChannelVerdictProvider,
  ChannelVerdictRuledVia,
} from '../models/ChannelVerdict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ChannelVerdict = require('../models/ChannelVerdict');

export const CHANNEL_VERDICT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface RecordChannelVerdict {
  integrationId: unknown;
  installationId?: unknown;
  podId: unknown;
  provider: ChannelVerdictProvider;
  event: {
    kind: ChannelVerdictEventKind;
    podMessageId: string;
    decisionId?: unknown;
  };
  verdict: ChannelVerdictKind;
  reason: string;
  at?: Date;
}

export interface MarkReachedHuman {
  // The same decision card can reach several member-owned channels. This is
  // mandatory so one person's reply never claims those sibling channels did
  // the reaching.
  integrationId: unknown;
  podMessageId: string;
  ruledVia: Extract<ChannelVerdictRuledVia, 'telegram' | 'slack'>;
}

export interface MarkRuled {
  podMessageId: string;
  ruledVia: ChannelVerdictRuledVia;
}

const matchedCount = (result: { matchedCount?: number; n?: number } | null | undefined): number => (
  Number(result?.matchedCount ?? result?.n ?? 0)
);

const expiryAfter = (at: Date): Date => new Date(at.getTime() + CHANNEL_VERDICT_RETENTION_MS);

const isOpenDecisionCard = (entry: RecordChannelVerdict): boolean => (
  entry.event.kind === 'decision_request'
  && entry.verdict === 'interrupt'
  && entry.reason === 'card'
);

/**
 * Writes are observational. A bridge has already sent (or deliberately held)
 * the card before this is called, so a ledger failure must never change relay
 * delivery. Upserting the model's unique integration/message key makes a
 * retry one durable fact rather than a second card receipt.
 */
export const record = async (entry: RecordChannelVerdict): Promise<void> => {
  try {
    const at = entry.at || new Date();
    await ChannelVerdict.updateOne(
      {
        integrationId: entry.integrationId,
        'event.podMessageId': entry.event.podMessageId,
      },
      {
        $setOnInsert: {
          integrationId: entry.integrationId,
          ...(entry.installationId ? { installationId: entry.installationId } : {}),
          podId: entry.podId,
          provider: entry.provider,
          event: entry.event,
          verdict: entry.verdict,
          reason: entry.reason,
          at,
          // A card does not become a historical fact until it is ruled. The
          // same model also records completed relays and holds, which expire
          // a quarter after their original event time.
          ...(!isOpenDecisionCard(entry) ? { expiresAt: expiryAfter(at) } : {}),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    console.warn('[channel-verdict] record failed:', (error as Error).message);
  }
};

/**
 * Record a channel-originated ruling. The selector is intentionally scoped to
 * the channel binding, not only the workspace message, because a card may
 * fan out to several gated connector owners.
 */
export const markReachedHuman = async (entry: MarkReachedHuman): Promise<void> => {
  try {
    const now = new Date();
    const reached = await ChannelVerdict.updateOne(
      {
        integrationId: entry.integrationId,
        'event.podMessageId': entry.podMessageId,
      },
      {
        $set: { reachedHumanAt: now, ruledVia: entry.ruledVia },
      },
    );
    if (!matchedCount(reached)) {
      console.warn('[channel-verdict] reach stamp matched no channel:', entry.podMessageId);
      return;
    }

    // This is a fork-level fact, unlike reachedHumanAt: every gated recipient
    // sees how the decision settled, but only the replying channel records
    // that its own human performed the action.
    await ChannelVerdict.updateMany(
      { 'event.podMessageId': entry.podMessageId },
      { $set: { ruledVia: entry.ruledVia, expiresAt: expiryAfter(now) } },
    );
  } catch (error) {
    console.warn('[channel-verdict] reach stamp failed:', (error as Error).message);
  }
};

/**
 * A workspace ruling settles every channel copy without claiming that any
 * channel human was reached. PR 3 calls this path; its counterpart above is
 * deliberately narrower for a Telegram or Slack ruling.
 */
export const markRuled = async (entry: MarkRuled): Promise<void> => {
  try {
    const now = new Date();
    const ruled = await ChannelVerdict.updateMany(
      { 'event.podMessageId': entry.podMessageId },
      { $set: { ruledVia: entry.ruledVia, expiresAt: expiryAfter(now) } },
    );
    if (!matchedCount(ruled)) {
      console.warn('[channel-verdict] ruling stamp matched no channels:', entry.podMessageId);
    }
  } catch (error) {
    console.warn('[channel-verdict] ruling stamp failed:', (error as Error).message);
  }
};
