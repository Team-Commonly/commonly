import type { DecisionOrigin } from './decisionRequestService';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const DecisionRequest = require('../models/DecisionRequest');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const isPodMember = require('../utils/isPodMember');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const telegramSend = require('./telegramService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const SlackApi = require('./slackApi');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('./connectorSecrets');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const channelVerdictService = require('./channelVerdictService');

const CLOSED_CARD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let sweepInFlight = false;

const mongoReady = (): boolean => !Integration?.db || Integration.db.readyState === 1;

interface DecisionRow {
  _id: unknown;
  podId: unknown;
  messageId?: string;
  ruling?: {
    value?: string;
    byUsername?: string;
  };
}

interface CardEntry {
  podMessageId: string;
  tgMessageId?: string;
  externalMessageId?: string;
  closedAt?: Date | string;
}

interface IntegrationDoc {
  _id: unknown;
  createdBy?: unknown;
  podId?: unknown;
  scope?: 'pod' | 'user';
  type?: string;
  status?: string;
  isActive?: boolean;
  config?: {
    liveRelay?: boolean;
    linkedUserId?: string;
    chatId?: string;
    chatType?: string;
    botTokenRef?: string;
    relayMutedUntil?: Date | string;
    adminPause?: unknown;
    gates?: Record<string, { enabled?: boolean }>;
    cards?: CardEntry[];
  };
}

const escapeSlack = (value: unknown): string => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const memberIdFor = (integration: IntegrationDoc): string | null => {
  const linked = integration.config?.linkedUserId;
  return linked ? String(linked) : null;
};

const canSendClosingLine = (
  integration: IntegrationDoc,
  podId: string,
  pod: unknown,
  now: Date,
): boolean => {
  if (integration.isActive !== true || integration.status === 'error') return false;
  if (integration.config?.liveRelay !== true || integration.config.adminPause) return false;
  if (integration.type !== 'telegram' && integration.type !== 'slack') return false;
  if (integration.scope === 'user' && integration.config.gates?.[podId]?.enabled !== true) return false;
  if (integration.scope !== 'user' && String(integration.podId) !== podId) return false;
  const mutedUntil = integration.config.relayMutedUntil;
  if (mutedUntil && new Date(mutedUntil).getTime() > now.getTime()) return false;
  const linkedUserId = memberIdFor(integration);
  if (!linkedUserId || !isPodMember(pod, linkedUserId)) return false;
  if (!integration.config.chatId) return false;
  if (integration.type === 'telegram') {
    return integration.config.chatType === 'private' && Boolean(process.env.TELEGRAM_BOT_TOKEN);
  }
  return integration.config.chatType === 'im' && Boolean(integration.config.botTokenRef);
};

const sendClosingLine = async (
  integration: IntegrationDoc,
  card: CardEntry,
  text: string,
): Promise<void> => {
  if (integration.type === 'telegram') {
    const sent = await telegramSend.sendMessage(
      process.env.TELEGRAM_BOT_TOKEN,
      String(integration.config?.chatId),
      text,
      { replyToMessageId: card.tgMessageId, plainText: true },
    );
    if (!sent?.success) throw new Error('Telegram ruling confirmation was not sent');
    return;
  }
  const token = await connectorSecrets.get(String(integration.config?.botTokenRef));
  const sent = await new SlackApi(token).postMessage(
    String(integration.config?.chatId),
    escapeSlack(text),
    undefined,
    card.externalMessageId,
  );
  if (!sent?.ok) throw new Error(`Slack ruling confirmation was not sent: ${String(sent?.error || 'unknown error')}`);
};

/**
 * Close every durable card receipt for a settled fork, then best-effort send
 * the interrupt confirmation to eligible sibling chats. The row settlement
 * is already durable when this runs, so a provider failure cannot make the
 * caller retry the ruling or leave one receipt looking open.
 */
export const fanoutDecisionClosure = async (
  decision: DecisionRow,
  origin: DecisionOrigin,
): Promise<void> => {
  const podMessageId = String(decision.messageId || '');
  if (!podMessageId) return;
  const now = new Date();
  const podId = String(decision.podId);
  const value = String(decision.ruling?.value || '');
  const by = String(decision.ruling?.byUsername || 'Human');

  // Unit callers can exercise the decision verb without booting Mongo. Do not
  // leave Mongoose's default 10-second buffer timer running in that case; the
  // production process always reaches this path after its DB is ready.
  if (!mongoReady()) return;

  // This is a fork-level ledger fact. It intentionally includes held rows;
  // the person who was muted or gate-off was still part of the decision's
  // channel census even though they did not receive the closing text.
  try {
    await channelVerdictService.markRuled({ podMessageId, ruledVia: origin.via });
  } catch (error) {
    // The ledger is observational; receipt closure and provider sends still
    // proceed when its projection is temporarily unavailable.
    console.warn('[decision-card] ruling ledger stamp failed:', (error as Error).message);
  }

  // Marking is unconditional and does not depend on connector liveness. Use
  // an array filter rather than an array index: sibling receipts may be
  // reordered or appended concurrently by the relay workers.
  try {
    await Integration.updateMany(
      { 'config.cards.podMessageId': podMessageId },
      { $set: { 'config.cards.$[card].closedAt': now } },
      { arrayFilters: [{ 'card.podMessageId': podMessageId }] },
    );
  } catch (error) {
    console.warn('[decision-card] closure stamp failed:', (error as Error).message);
  }

  let integrations: IntegrationDoc[];
  try {
    integrations = await Integration.find({ 'config.cards.podMessageId': podMessageId }).lean();
  } catch (error) {
    console.warn('[decision-card] closure lookup failed:', (error as Error).message);
    return;
  }

  let pod: unknown = null;
  try {
    pod = await Pod.findById(podId).select('members createdBy').lean();
  } catch (error) {
    console.warn('[decision-card] membership lookup failed:', (error as Error).message);
  }
  const text = `✓ Ruled by ${by}: ${value}`;
  // Provider delivery is deliberately detached. The local ledger and receipt
  // writes above are part of the ruling's durable return contract; a stalled
  // sibling API must not hold up the typed event or HTTP response.
  void Promise.allSettled(integrations.map(async (integration) => {
    if (String(integration._id) === String(origin.integrationId || '')) return;
    if (!canSendClosingLine(integration, podId, pod, now)) return;
    const card = (integration.config?.cards || []).find((entry) => entry.podMessageId === podMessageId);
    if (!card) return;
    try {
      await sendClosingLine(integration, card, text);
    } catch (error) {
      console.warn(`[decision-card] ${integration.type} ruling confirmation failed:`, (error as Error).message);
    }
  }));
};

const stampClosed = async (integrationId: unknown, podMessageId: string, now: Date): Promise<void> => {
  await Integration.updateOne(
    {
      _id: integrationId,
      'config.cards': { $elemMatch: { podMessageId, closedAt: { $exists: false } } },
    },
    { $set: { 'config.cards.$[card].closedAt': now } },
    { arrayFilters: [{ 'card.podMessageId': podMessageId, 'card.closedAt': { $exists: false } }] },
  );
};

/**
 * Repair durable receipts and bound their retention. A failed row lookup is
 * skipped, never interpreted as a missing decision, so a transient Mongo
 * outage cannot close every live card in a connector.
 */
export const sweepDecisionCards = async (now: Date = new Date()): Promise<{
  stamped: number;
  removed: number;
}> => {
  if (sweepInFlight) return { stamped: 0, removed: 0 };
  sweepInFlight = true;
  try {
  if (!mongoReady()) return { stamped: 0, removed: 0 };
  let integrations: IntegrationDoc[];
  try {
    integrations = await Integration.find({ 'config.cards.0': { $exists: true } }).lean();
  } catch (error) {
    console.warn('[decision-card] sweep lookup failed:', (error as Error).message);
    return { stamped: 0, removed: 0 };
  }

  const cutoff = new Date(now.getTime() - CLOSED_CARD_RETENTION_MS);
  const messageIds = [...new Set(integrations.flatMap((integration) =>
    (integration.config?.cards || []).map((card) => card.podMessageId)))];
  let rows: Array<{ messageId?: string; status?: string }>;
  try {
    rows = await DecisionRequest.find({ messageId: { $in: messageIds } }).select('messageId status').lean();
  } catch (error) {
    console.warn('[decision-card] sweep row lookup failed:', (error as Error).message);
    return { stamped: 0, removed: 0 };
  }
  const rowByMessageId = new Map(rows.map((row) => [String(row.messageId), row]));
  let stamped = 0;
  let removed = 0;
  for (const integration of integrations) {
    for (const card of integration.config?.cards || []) {
      const row = rowByMessageId.get(card.podMessageId) || null;
      // Pending + closedAt is unreachable by construction. Treat it as a
      // protected invariant rather than pruning or unsetting the mark.
      if (row && row.status === 'pending') continue;
      if (card.closedAt) {
        if (new Date(card.closedAt).getTime() > cutoff.getTime()) continue;
        if (row && row.status !== 'ruled') continue;
        try {
          const result = await Integration.updateOne(
            { _id: integration._id },
            { $pull: { 'config.cards': { podMessageId: card.podMessageId, closedAt: { $lte: cutoff } } } },
          );
          removed += Number(result?.modifiedCount ?? result?.nModified ?? 0);
        } catch (error) {
          console.warn('[decision-card] sweep prune failed:', (error as Error).message);
        }
        continue;
      }
      if (row && row.status !== 'ruled') continue;
      // A missing row and a ruled row are both finished. Pending + closedAt is
      // unreachable by construction and therefore remains untouched forever.
      try {
        await stampClosed(integration._id, card.podMessageId, now);
        stamped += 1;
      } catch (error) {
        console.warn('[decision-card] sweep close stamp failed:', (error as Error).message);
      }
    }
  }
  return { stamped, removed };
  } finally {
    sweepInFlight = false;
  }
};

export { CLOSED_CARD_RETENTION_MS };

// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { fanoutDecisionClosure, sweepDecisionCards, CLOSED_CARD_RETENTION_MS };
