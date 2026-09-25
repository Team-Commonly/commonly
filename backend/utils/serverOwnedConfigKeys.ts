/**
 * Config keys the SERVER owns: a request body may not set any of them.
 *
 * `stripServerOwnedConfig` (`routes/integrations.ts`) deletes every key here
 * before a write, and the two Discord refusals run ahead of that strip so a
 * supplied value is a 400 rather than a silent 200. The list lives in its own
 * module because the manifest contract reads it too: `requiredConfig` publishes
 * "what a caller supplies" to `GET /api/integrations/catalog`, and the catalog
 * used to publish `botToken` while this list refused it — one field, two
 * answers, because the two lists lived in different files (TASK-140).
 *
 * Invariants, both guarded by
 * `__tests__/unit/integrations/manifestCallerContract.test.js`:
 *   · no manifest's `requiredConfig` names a key in this list (a published lie);
 *   · every manifest's `serverOwnedConfig` names a key in this list (a hidden
 *     caller-suppliable field, which is the same defect mirrored).
 */

// Bridge attribution + binding fields are server-owned. linkedUserId is the
// identity every inbound live-relay message is AUTHORED as; chatId/chatType
// are written only by the /commonly-enable webhook (the code is the proof);
// connectCode is minted here. Accepting any of them from a client body lets a
// caller name someone else as the author or bind a chat without a code.
export const SERVER_OWNED_CONFIG_KEYS = [
  'linkedUserId', 'connectCode', 'connectCodeExpiresAt', 'chatId', 'chatType', 'chatTitle',
  // GitHub App connection identity is administrator-owned. A member may not
  // retarget an existing row that a grant already references.
  'installationId', 'owner', 'repo',
  // OAuth callback and connectorSecrets own Slack identity and its opaque
  // credential reference. Accepting either from a browser body defeats D6.
  'botTokenRef', 'teamId', 'teamName', 'slackUserId', 'slackUserName', 'pendingBind',
  // The token itself, one layer in from the opaque ref above: it is read as a
  // credential by `providers/slackProvider`, by `routes/registry/helpers` (Slack
  // and Telegram, each with an env fallback) and by the Discord resolver's
  // legacy fallback, and its only writer is a caller's body — Slack's live bind
  // stores `botTokenRef` and Telegram's runtime reads the env var. Left
  // unstripped, a caller can drive their own row to `status: 'connected'` with a
  // value no provider echoes, and plant a legacy fallback that a later
  // rotation no longer reaches. The two Discord refusals are kept and still run
  // FIRST (they precede this strip on both routes), so a supplied Discord token
  // is a 400 rather than a silent 200.
  'botToken',
  // The Discord channel webhook URL is a bearer credential of its own — the URL
  // embeds the webhook's token, so posting to it posts AS that channel — and the
  // server derives it from the Discord API on both writers (`routes/integrations`
  // at connect, `services/discordService` on a backfill). No browser sends it, and
  // a caller-planted value would be read as the legacy fallback in
  // `utils/discordWebhookUrl`. `webhookUrlRef` is the pointer to the encrypted
  // copy: like the Slack ref above, accepting it from a body would let a caller
  // point their row at another row's secret.
  'webhookUrl', 'webhookUrlRef',
  // An administrator's pause is projected from the parent installation. An
  // owner's normal config write must never lift that stop.
  'adminPause',
  // A receipt proves this channel was shown the card. Owners may configure
  // gates, but cannot invent, retarget, or close receipts from a browser.
  'cards',
  // Routing state is written by the bridges, never by a browser: relayMap is
  // the reply window, messageBuffer the recent-lines digest a bridge reads to
  // answer context, and webhookListenerEnabled a runtime switch the Discord
  // gateway reads. A body that sets any of the three names a destination or
  // starts a listener the caller was never granted.
  'relayMap', 'messageBuffer', 'webhookListenerEnabled',
];

export const isServerOwnedConfigKey = (key: string): boolean => SERVER_OWNED_CONFIG_KEYS.includes(key);

export default SERVER_OWNED_CONFIG_KEYS;
