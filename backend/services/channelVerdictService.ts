import type {
  ChannelVerdictEventKind,
  ChannelVerdictKind,
  ChannelVerdictProvider,
  ChannelVerdictRuledVia,
} from '../models/ChannelVerdict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ChannelVerdict = require('../models/ChannelVerdict');

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

/**
 * Writes are observational. A bridge has already sent (or deliberately held)
 * the card before this is called, so a ledger failure must never change relay
 * delivery. Upserting the model's unique integration/message key makes a
 * retry one durable fact rather than a second card receipt.
 */
export const record = async (entry: RecordChannelVerdict): Promise<void> => {
  try {
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
          at: entry.at || new Date(),
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
    await ChannelVerdict.updateOne(
      {
        integrationId: entry.integrationId,
        'event.podMessageId': entry.podMessageId,
      },
      {
        $set: { reachedHumanAt: new Date(), ruledVia: entry.ruledVia },
      },
    );
  } catch (error) {
    console.warn('[channel-verdict] reach stamp failed:', (error as Error).message);
  }
};
