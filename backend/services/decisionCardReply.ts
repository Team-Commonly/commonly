import type { IDecisionRequest } from '../models/DecisionRequest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const DecisionRequest = require('../models/DecisionRequest');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const isPodMember = require('../utils/isPodMember');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const verdicts = require('./channelVerdictService');

export interface ChannelCardEntry {
  podMessageId: string;
  tgMessageId?: string;
  externalMessageId?: string;
  sentAt: Date | string;
  closedAt?: Date | string;
}

interface CardReplyResult {
  handled: boolean;
  confirmation?: string;
  externalMessageId?: string;
  lateReply?: { podId: string; messageId: string; threadRootId?: string };
}

/**
 * The provider establishes the DM identity first. This service resolves only
 * cards actually sent to that binding; the active chat pod is not the card's
 * authority. It never writes a DecisionRequest or a human message.
 */
export const resolveDecisionCardReply = async (input: {
  integrationId: unknown;
  linkedUserId: string;
  cards?: ChannelCardEntry[];
  provider: 'telegram' | 'slack';
  text: string;
  replyToExternalId?: string;
}): Promise<CardReplyResult> => {
  const cards = Array.isArray(input.cards) ? input.cards : [];
  if (!cards.length) return { handled: false };
  let card: ChannelCardEntry | undefined;
  let row: IDecisionRequest | null = null;
  if (input.replyToExternalId) {
    card = cards.find((entry) => (
      String(entry.externalMessageId ?? entry.tgMessageId) === input.replyToExternalId
    ));
    // An explicit reply to an ordinary line (or our confirmation) must never
    // be reinterpreted as a bare-number ruling on some unrelated card.
    if (!card) return { handled: false };
    row = await DecisionRequest.findOne({ messageId: card.podMessageId }).lean();
  } else {
    if (!/^\d{1,2}$/.test(input.text)) return { handled: false };
    const open = cards.filter((entry) => !entry.closedAt);
    if (!open.length) return { handled: false };
    const pending: IDecisionRequest[] = await DecisionRequest.find({
      messageId: { $in: open.map((entry) => entry.podMessageId) }, status: 'pending',
    }).lean();
    if (!pending.length) return { handled: false };
    if (pending.length > 1) {
      return { handled: true, confirmation: 'Which one? Reply to the card you mean.' };
    }
    [row] = pending;
    card = open.find((entry) => entry.podMessageId === row?.messageId);
  }
  const externalMessageId = card?.externalMessageId ?? card?.tgMessageId;
  const answer = (confirmation: string): CardReplyResult => ({
    handled: true, externalMessageId, confirmation,
  });
  if (!row || !card) return answer('This card is no longer available. Open Commonly to check the thread.');
  const podId = String(row.podId);
  const base = (process.env.PUBLIC_APP_URL || 'https://commonly.me').replace(/\/$/, '');
  const link = `${base}/v2/pods/${encodeURIComponent(podId)}?message=${encodeURIComponent(card.podMessageId)}`;
  const pod = await Pod.findById(podId).select('name members createdBy').lean();
  const caller = await User.findById(input.linkedUserId).select('isBot').lean();
  const denied = `You're no longer in ${pod?.name || 'this pod'}, so this ruling can't be recorded.`
    + ` Open it in Commonly: ${link}`;
  // chooseDecision's already-ruled response precedes its membership guard.
  // Protect the late-reply writer and standing ruling from ex-members too.
  if (!pod || !caller || caller.isBot || !isPodMember(pod, input.linkedUserId)) return answer(denied);

  const close = async (): Promise<void> => {
    try {
      await Integration.updateOne(
        { _id: input.integrationId },
        { $set: { 'config.cards.$[card].closedAt': new Date() } },
        { arrayFilters: [{ 'card.podMessageId': card.podMessageId, 'card.closedAt': { $exists: false } }] },
      );
    } catch (error) {
      // Settlement has committed. Never turn a projection failure into a
      // provider retry of the human's ruling; PR 3's sweep will repair this mark.
      console.warn('[decision-card] close stamp failed:', (error as Error).message);
    }
  };
  const alreadyRuled = async (ruling: {
    at?: Date | string; by?: string; byUsername?: string; value?: string;
  }): Promise<CardReplyResult> => {
    await close();
    const minutes = ruling.at == null ? NaN
      : Math.max(0, Math.floor((Date.now() - new Date(ruling.at).getTime()) / 60_000));
    let rel = '';
    if (Number.isFinite(minutes)) {
      if (minutes < 1) rel = ' just now';
      else if (minutes < 60) rel = ` ${minutes}m ago`;
      else if (minutes < 1440) rel = ` ${Math.floor(minutes / 60)}h ago`;
      else rel = ` ${Math.floor(minutes / 1440)}d ago`;
    }
    return {
      ...answer(`Already ruled${rel} by ${ruling.by || ruling.byUsername || 'Human'}: ${ruling.value || ''}.`
        + ` To change it, the agent asks again — say so in the workspace: ${link}`),
      lateReply: {
        podId, messageId: card.podMessageId, ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
      },
    };
  };
  if (row.status === 'ruled') return alreadyRuled(row.ruling || {});
  if (card.closedAt) return answer(`This card has closed. Open it in Commonly to confirm: ${link}`);
  let value = input.text.trim().slice(0, 2000);
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (index < 0 || index >= row.options.length) return answer(`Pick 1–${row.options.length}, or write your ruling.`);
    value = row.options[index].label;
  }
  // Load at the reply boundary: requestDecision itself dispatches outbound
  // cards, and importing its graph at bridge boot would create a cycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { chooseDecision } = require('./decisionRequestService');
  let outcome: { status: number; body: Record<string, any> };
  try {
    outcome = await chooseDecision({
      decisionId: String(row._id),
      callerUserId: input.linkedUserId,
      value,
      origin: { via: input.provider, integrationId: input.integrationId },
    });
  } catch (error) {
    const failure = error as { status?: number; code?: string };
    if (failure.code === 'ruling_finalize_conflict') {
      return answer("Your ruling reached the workspace, but the card didn't close."
        + ` Open it in Commonly to confirm: ${link}`);
    }
    if (failure.code === 'ruling_not_posted') {
      return answer("Couldn't record that — nothing was saved. Try again in a moment.");
    }
    // An unclassified error can occur after the verb's durable write. Do not
    // claim nothing was saved, retry the verb, or fall through to normal chat.
    console.error('[decision-card] ruling outcome unknown:', (error as Error).message);
    return answer(`Couldn't confirm the ruling. Check the thread in Commonly before trying again: ${link}`);
  }
  if (outcome.status === 200) {
    await close();
    await verdicts.markReachedHuman({
      integrationId: input.integrationId, podMessageId: card.podMessageId, ruledVia: input.provider,
      decisionId: String(row._id),
    });
    return answer(`✓ Ruled: ${value}`);
  }
  if (outcome.status === 403) return answer(denied);
  if (outcome.status === 409 && outcome.body.decision?.status === 'ruled') {
    return alreadyRuled(outcome.body.decision.ruling || {});
  }
  if (outcome.status === 409) return answer('Someone is ruling this right now — try again in a moment.');
  if (outcome.status === 503 && outcome.body.code === 'ruling_not_posted') {
    return answer("Couldn't record that — nothing was saved. Try again in a moment.");
  }
  return answer(`Couldn't confirm the ruling. Check the thread in Commonly before trying again: ${link}`);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { resolveDecisionCardReply };
