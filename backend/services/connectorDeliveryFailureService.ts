import Integration from '../models/Integration';
import Activity from '../models/Activity';

// Row D: a permanent delivery failure used to change nothing at all — the
// integration stayed `connected`, `errorMessage` stayed null, no Activity row
// was written and the relay kept running, so replies vanished while the page
// said the connector was fine. The fix is to classify the failure at the call
// site that sent it and flip the connector only for the chats it owns.
//
// Classification lives at the call site, not inside sendMessage (wren 73777):
// a Telegram chat id has two provenances — the connector's own bound chat, and
// the chat an inbound update came from. A 400/403 on the second says nothing
// about the first: a stranger who holds a connect code, binds, then blocks the
// bot would otherwise mark someone's working connector as needing attention
// (vera 73761). `noteBoundChatDeliveryFailure` can only ever act on the bound
// chat, so that wiring mistake is refused rather than merely discouraged.

// The page shows a cause, not a number: "the bot was blocked" is actionable,
// "403" is not.
const TELEGRAM_BLOCKED_REASON = 'Telegram stopped delivering: the bot was blocked or removed from this chat.';
const TELEGRAM_CHAT_GONE_REASON = 'Telegram stopped delivering: this chat no longer exists.';

interface DeliveryResult {
  success?: boolean;
  errorCode?: number;
  description?: string;
}

/**
 * Telegram's own error_code/description → a named reason, or null when the
 * failure says nothing about this connector.
 *
 *  403  blocked, kicked, or the bot was stopped        → permanent
 *  400  description "chat not found"                   → permanent (the chat is gone)
 *  401  our shared bot token, not this connector       → never
 *  400  anything else — an unescaped entity, a bad offset, a bad offset in the
 *       reply target. Content, not reachability: a pod named `A <b>` used to 400
 *       every confirmation, and that must not undo a working bind (wren 73778).
 *  429/5xx, and anything we did not classify            → never
 */
const classifyTelegramDeliveryFailure = (result?: DeliveryResult | null): string | null => {
  if (!result || result.success === true) return null;
  if (result.errorCode === 403) return TELEGRAM_BLOCKED_REASON;
  if (result.errorCode === 400 && /chat not found/i.test(String(result.description || ''))) {
    return TELEGRAM_CHAT_GONE_REASON;
  }
  return null;
};

interface FlipInput {
  integrationId: unknown;
  failedChatId: unknown;
  reason: string;
}

/**
 * One matched update, then an Activity row only if it matched (wren 73779).
 *
 * The match on `config.chatId` is the race guard: if the connector was
 * re-bound between the send and this call, the update matches nothing and no
 * row is written — we would be reporting a failure for a chat it no longer
 * owns. Unsetting the chat id is also what stops the relay (no relay predicate
 * reads `status`) and what allows a reconnect (the connect-code route 409s
 * while a chat id is present).
 */
const flipConnectorOnPermanentDeliveryFailure = async ({
  integrationId,
  failedChatId,
  reason,
}: FlipInput): Promise<boolean> => {
  const matched = await Integration.findOneAndUpdate(
    { _id: integrationId, 'config.chatId': String(failedChatId) },
    {
      $set: { status: 'error', errorMessage: reason },
      $unset: { 'config.chatId': '' },
    },
    { new: true },
  );
  if (!matched) return false;

  await Activity.create({
    type: 'pod_event',
    actor: { id: null, name: 'Commonly', type: 'system', verified: true },
    action: 'connector_delivery_failed',
    content: `${reason} Relaying is stopped until this connector is reconnected.`,
    podId: matched.podId,
    sourceType: 'event',
  });
  return true;
};

/**
 * Call this only from a send that targeted the connector's own bound chat.
 *
 * `sentToChatId` is compared against the stored one on purpose: the four sites
 * that may flip all send to `integration.config.chatId`, and the receive-side
 * replies in the Telegram webhook send to the chat the update came from. Passing
 * an inbound chat here is the griefing lever, and it returns false instead of
 * flipping someone else's working connector.
 */
const noteBoundChatDeliveryFailure = async (
  integration: { _id?: unknown; config?: { chatId?: unknown } } | null | undefined,
  sentToChatId: unknown,
  result?: DeliveryResult | null,
): Promise<boolean> => {
  const boundChatId = integration?.config?.chatId;
  if (!boundChatId || !sentToChatId || String(boundChatId) !== String(sentToChatId)) return false;

  const reason = classifyTelegramDeliveryFailure(result);
  if (!reason) return false;

  return flipConnectorOnPermanentDeliveryFailure({
    integrationId: integration?._id,
    failedChatId: boundChatId,
    reason,
  });
};

export {
  classifyTelegramDeliveryFailure,
  flipConnectorOnPermanentDeliveryFailure,
  noteBoundChatDeliveryFailure,
  TELEGRAM_BLOCKED_REASON,
  TELEGRAM_CHAT_GONE_REASON,
};
