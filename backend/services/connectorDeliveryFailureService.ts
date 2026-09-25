import Integration from '../models/Integration';

// Row D: a permanent delivery failure used to change nothing at all — the
// integration stayed `connected`, `errorMessage` stayed null and the relay kept
// running, so replies vanished while the page said the connector was fine. The
// fix is to classify the failure at the call site that sent it and flip the
// connector only for the chats it owns.
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

// Slack reports the same three situations in its own vocabulary (wren 73779).
const SLACK_CHANNEL_GONE_REASON = 'Slack stopped delivering: this channel no longer exists.';
const SLACK_BOT_REMOVED_REASON = 'Slack stopped delivering: the bot is not in this channel.';
const SLACK_CHANNEL_ARCHIVED_REASON = 'Slack stopped delivering: this channel was archived.';

/**
 * Slack's permanent errors. `invalid_auth`, `token_revoked` and `account_inactive`
 * are deliberately absent: they are the shared bot app, the analogue of
 * Telegram's 401, and they must never mark one connector as needing attention.
 * Everything else (`ratelimited`, `msg_too_long`, `invalid_blocks`,
 * `internal_error`) is transient or content.
 */
const PERMANENT_SLACK_ERRORS: { [error: string]: string } = {
  channel_not_found: SLACK_CHANNEL_GONE_REASON,
  not_in_channel: SLACK_BOT_REMOVED_REASON,
  is_archived: SLACK_CHANNEL_ARCHIVED_REASON,
};

interface DeliveryResult {
  success?: boolean;
  errorCode?: number;
  description?: string;
}

interface SlackDeliveryResult {
  ok?: boolean;
  error?: string;
}

/**
 * Slack's own `error` string → a named reason, or null when the failure says
 * nothing about this connector. See PERMANENT_SLACK_ERRORS for what is excluded
 * and why.
 */
const classifySlackDeliveryFailure = (result?: SlackDeliveryResult | null): string | null => {
  if (!result || result.ok !== false) return null;
  return PERMANENT_SLACK_ERRORS[String(result.error || '').toLowerCase()] || null;
};

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
 *
 * `errorCode`/`description` are read off the axios throw, so a Telegram reply
 * that arrives as HTTP 200 with `ok: false` reaches here as a plain success and
 * classifies as null. That is the direction this must fail in: a missed flip is
 * a connector that keeps relaying until the next failure names it, a wrong flip
 * is someone's working connector marked broken (vera 73849).
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
 * One matched update and nothing else. The Activity row that 73779 attached to
 * this was withdrawn in 73792 — V2 renders none: the frontend never calls
 * /api/activity/feed, the recap keeps agent actors, and needs-you reads only
 * AttentionItem, so the row would have been written and never read.
 *
 * The match on `config.chatId` is the race guard: if the connector was
 * re-bound between the send and this call, the update matches nothing and no
 * row is written — we would be reporting a failure for a chat it no longer
 * owns. Unsetting the chat id is what allows a reconnect (the connect-code
 * route 409s while a chat id is present), and it is what stops the Telegram
 * relay — that predicate reads the chat id and the pause flag, never `status`.
 * The Slack relay filters `status: { $ne: 'error' }` as well
 * (slackBridgeService.findLiveIntegration), so there the flip stops it twice.
 *
 * `errorMessage` on its own cannot say the reason is fit to read: this field has
 * a second, older writer — externalFeedService copies a provider's error text or
 * a raw `err.message` (`connect ECONNREFUSED <addr>:443`) into it for `x` and
 * `instagram` rows — and the page renders every `status: 'error'` row through
 * one branch. So "the field has a value" is not the same fact as "the value was
 * written for a person". `errorMessageUserFacing` is that fact, this module is
 * its only writer, and the page renders the message only when it is set; a
 * writer that does not set it falls back to the generic sentence instead of
 * printing our stack text in a connector row (vera 73848).
 */
const userFacingError = (reason: string) => ({
  status: 'error',
  errorMessage: reason,
  errorMessageUserFacing: true,
});

/**
 * The flip's update payload, and the reconciler's — one home for the pair, so a
 * second user-facing writer cannot forget half of it.
 */
const flipConnectorOnPermanentDeliveryFailure = async ({
  integrationId,
  failedChatId,
  reason,
}: FlipInput): Promise<boolean> => {
  const matched = await Integration.findOneAndUpdate(
    { _id: integrationId, 'config.chatId': String(failedChatId) },
    {
      $set: userFacingError(reason),
      $unset: { 'config.chatId': '' },
    },
    { new: true },
  );
  if (!matched) return false;
  return true;
};

/**
 * The two providers report failure in their own shapes — `{success: false,
 * errorCode}` and `{ok: false, error}` — and the call sites hand over whatever
 * their provider returned, so the entry point sorts them by shape rather than
 * making every caller name its provider.
 */
const classifyDeliveryFailure = (result?: (DeliveryResult & SlackDeliveryResult) | null): string | null => (
  result && result.ok === false ? classifySlackDeliveryFailure(result) : classifyTelegramDeliveryFailure(result)
);

/**
 * Call this only from a send that targeted the connector's own bound chat — for
 * either provider, since both store it in `config.chatId`.
 *
 * `sentToChatId` is compared against the stored one on purpose: the sites that
 * may flip all send to `integration.config.chatId`, and the receive-side replies
 * in the Telegram webhook send to the chat the update came from. Passing an
 * inbound chat here is the griefing lever, and it returns false instead of
 * flipping someone else's working connector.
 */
const noteBoundChatDeliveryFailure = async (
  integration: { _id?: unknown; config?: { chatId?: unknown } } | null | undefined,
  sentToChatId: unknown,
  result?: (DeliveryResult & SlackDeliveryResult) | null,
): Promise<boolean> => {
  const boundChatId = integration?.config?.chatId;
  if (!boundChatId || !sentToChatId || String(boundChatId) !== String(sentToChatId)) return false;

  const reason = classifyDeliveryFailure(result);
  if (!reason) return false;

  return flipConnectorOnPermanentDeliveryFailure({
    integrationId: integration?._id,
    failedChatId: boundChatId,
    reason,
  });
};

/**
 * A connector-level failure that is not a delivery error but whose reason is
 * still ours and still written for the person reading the page: the reconciler
 * found that this row's connector secret can no longer be decrypted. Same
 * `$set` as the flip; the filter stays the caller's own guard, and a row the
 * user has already deactivated must not be marked.
 */
const markConnectorUnavailable = async (
  integration: { _id?: unknown } | null | undefined,
  reason: string,
): Promise<boolean> => {
  if (!integration?._id) return false;
  const result = await Integration.updateOne(
    { _id: integration._id, isActive: true },
    { $set: userFacingError(reason) },
  );
  return (result.matchedCount || 0) > 0;
};

export {
  classifyDeliveryFailure,
  classifySlackDeliveryFailure,
  classifyTelegramDeliveryFailure,
  flipConnectorOnPermanentDeliveryFailure,
  markConnectorUnavailable,
  noteBoundChatDeliveryFailure,
  TELEGRAM_BLOCKED_REASON,
  TELEGRAM_CHAT_GONE_REASON,
  SLACK_BOT_REMOVED_REASON,
  SLACK_CHANNEL_ARCHIVED_REASON,
  SLACK_CHANNEL_GONE_REASON,
};
