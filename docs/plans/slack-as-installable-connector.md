# Slack as the second installable connector — design note (TASK-006)

**Status:** design note, 2026-09-04. Written against ADR-025 (D1–D17) and the merged Telegram
plan [`connector-as-installable-app.md`](connector-as-installable-app.md) as built by #1527
(backend, `e6851d6f`) and #1531 (page, `2a5d51fc`). Verification plan: Vera. Build: Kai, one
backend PR and one page PR, stacked the same way.

The short version: **Slack is Telegram with two substitutions.** The OAuth `state` parameter is
the connect code, and the OAuth callback is the enable command; and the per-workspace bot token
is the first credential the substrate has to hold that is not in env, which makes D6's secret
reference a prerequisite rather than a nice-to-have. Everything else — manifest, claim, projectors,
activation, reconciler, dispatcher, page states — is reused unchanged.

## 1. Identical to Telegram (reused, not re-decided)

- **Manifest shape.** `kind: 'app'`, `source: 'builtin'`, `scope: 'user'` (D8), two components:
  `webhook` (internal path the server mounts) and `event-handler` (`eventType: 'chat.message'`,
  `eventHandler: 'internal:slack.relay'`). Seeded from the provider registry's catalog entry the way
  `seed-builtin-connectors.ts` seeds Telegram; display copy stays in `integrations/manifests.ts`.
- **Lifecycle.** The parent `InstallableInstallation` claim, `installing → activating → active`,
  `uninstalling → uninstalled`, the claim generation (`claimId`), the 60 s lease and takeover, the
  reconciler's complete-or-demote sweep, `boundPodId`, the 200/202/409 contract of
  `POST /api/installables/slack/install` and `DELETE` — all of #1527, byte for byte. Nothing in
  this note adds a state.
- **Projection.** The webhook projector creates the Integration row `isActive: false`, no code,
  `installationId` back-pointer, `linkedUserId = installedBy`, `liveRelay` and
  `relayAllAgentMessages` true, `podId` = the picked gate pod (Phase 1 of D8, unchanged). The
  activation CAS mints the one bearer secret and sets `podId`, exactly as for Telegram.
- **One install per user; the pod picker is the first gate row.** Same 409 `already_installed`
  with `boundPodId` for a live row bound elsewhere.
- **Private surface only (D8, D15).** The DM with the bot is the user's attention surface; a
  Slack *channel* is the team-group case D7 keeps dormant until per-sender attribution exists.
  Inbound from anything but the bound DM is refused; outbound is never offered to a channel.
- **Routing rules (D9–D14).** Transport is kernel; agents never carry bytes. Outbound lines carry
  `[PodName]` (D10). The relay map is the routing table (D10) and the reply-to-a-relayed-line router
  (D11) is primary. Precedence for a bare message is D12's, unchanged.
- **Page.** `V2ConnectorsPage` already speaks the lifecycle states through `installableLifecyclePath(type)`;
  the Slack tile flips `enabled: true`. The pending card shows an *Authorize in Slack* link where
  Telegram shows *Copy command* (§4) — a different affordance for the same `pending` state, not a
  new state. `New code` re-mints, as today. Browse stays deferred to the marketplace-unlock PR.
- **Security carry-over from #1297.** Write limiter on every route that mints; `stripServerOwnedConfig`
  on PATCH; `readRelayFlags` refusing non-canonical booleans; 128-bit single-use 10-minute codes;
  the identity stamp at projection, not at the callback.

## 2. Where Slack differs

### 2a. Identity and binding: the OAuth `state` is the connect code

Telegram binds a chat by a human typing `/commonly-enable <code>` in a private chat; the chat that
sends the code is the identity proof, and #1297's private-chat gate makes it the user's own DM.

Slack has no bot DM before the app is installed to the workspace, and installation is an OAuth v2
round trip. So the bearer secret Telegram hands to the user is, for Slack, the `state` parameter:

1. **Activation mints the code** with the same `mintConnectCode()` (128-bit, 10-minute TTL,
   single-use) into `config.connectCode` / `config.connectCodeExpiresAt`. The parent goes `active`;
   the Integration row is active and `status: 'pending'` with no team and no chat — the same
   "waiting for the channel" the Telegram card shows. The lease is not held across the consent
   screen: the user's wait is the code's TTL, not the claim's.
2. **The page renders the authorize link**, built server-side by `GET /api/installables/slack/authorize-url`
   (auth, owner only): `https://slack.com/oauth/v2/authorize?client_id=…&scope=…&state=<code>&redirect_uri=…`.
   The code never appears in copy the user must type.
3. **The callback proves the Slack side; the owner confirms the bind.** (Amended after Vera,
   2026-09-04: a `state` that travels page → address bar → Referer → slack.com → our ingress logs
   is a bearer secret with a wider blast radius than a code typed into a DM. Whoever completes
   consent inside the TTL would otherwise bind *their* DM to the installer's `linkedUserId` — an
   impersonation seat.) So the callback never flips a row to `connected`. Two walls:

   - **Session nonce (SameSite=Lax cookie).** `authorize-url` is a `POST` made with credentials;
     its response sets `slack_oauth_nonce` (random, HttpOnly, Secure, SameSite=Lax, Max-Age 300)
     on the API origin and stores `sha256(nonce)` on the row beside the code. Slack's redirect is a
     top-level GET, so the cookie arrives at the callback; a `state` without its nonce is refused
     before any exchange. The one CORS change is credentials on that route for the app origin.
   - **Confirm in Commonly.** `GET /api/webhooks/slack/oauth/callback?code&state` is
     unauthenticated like the Telegram webhook. It resolves the row by
     `{ type: 'slack', isActive: true, 'config.connectCode': state, 'config.chatId': { $exists: false } }`,
     checks the nonce, refuses expired, unknown or reused states (single-use,
     `isConnectCodeExpired` fail-closed), exchanges `code` at `oauth.v2.access`, and on success
     writes a **pending bind** — `config.pendingBind: { teamId, teamName, slackUserId, slackUserName,
     chatId, botTokenRef }`, code fields cleared — then redirects to the Connectors page. The card
     shows "Slack workspace *Acme* wants to connect as *@sam* — Confirm / Not me".
     `POST /api/installables/slack/confirm` (auth; target derived from the caller's identity, never
     from a body id) moves `pendingBind` into `teamId`, `slackUserId`, `chatId`, `chatType: 'im'`,
     `status: 'connected'`. `POST …/reject` (same derivation) revokes the ref and clears the bind;
     so does an unconfirmed bind after 10 minutes (reconciler). The Telegram-parity of this step is
     the D15 follow-up the ADR already names (bind the redeemer, confirm in Commonly); Slack lands
     it first because its code is the more exposed of the two.

   Confirm is a sub-state of *pending* on the page (`status !== 'connected'`, `pendingBind` set):
   the same card with two buttons instead of a link — an affordance, not a lifecycle state. No
   relay runs and no token is used before Confirm. A failed exchange writes nothing; *New code*
   re-mints and rotates the nonce.
4. **Inbound is resolved by the event, not the URL.** A Slack app has one Events URL; the legacy
   `/api/webhooks/slack/:integrationId` route stays for legacy rows. The installable path is
   `POST /api/webhooks/slack/events`, verified with the app-level signing secret, and the row is
   found by `{ type: 'slack', 'config.teamId': event.team, 'config.chatId': event.channel,
   isActive: true }` — a compound index on those three. `channel_type !== 'im'` is dropped before
   lookup (the private-chat gate, Slack spelling).

### 2b. The bot token: D6 becomes a prerequisite

Telegram has one bot, its token in env. Slack's `oauth.v2.access` returns a **per-workspace**
`xoxb` token that outbound must present. The legacy provider stores `config.botToken` and
`config.signingSecret` in plaintext on the row; ADR-025 D6 says no seventh plaintext credential
ships, and this would be it.

Decision for Phase 1: **application-level envelope encryption, referenced from the row.**
`ConnectorSecret { _id, integrationId, provider, ciphertext, iv, tag, keyId, createdAt }` stored
with AES-256-GCM under `CONNECTOR_SECRET_KEY` (32 bytes, supplied through the existing `api-keys`
ExternalSecret like every other key); the Integration row carries `config.botTokenRef` (the
ConnectorSecret id), never the material. One module, `services/connectorSecrets.ts`, with
`put(integrationId, provider, material) → ref` and `get(ref) → material`, is the whole surface.
Read only by `slackBridgeService` at send time; never returned by any route (`stripServerOwnedConfig`
already strips server-owned keys; `botTokenRef` joins that list). Uninstall's unproject calls
`revoke(ref)` (deletes the ConnectorSecret; `auth.revoke` at Slack is best-effort, logged, never
blocking). ESO-per-workspace or a KMS envelope can replace the module later without touching a
caller — the ref is the contract.

The signing secret, client id and client secret are **app-level** and live in env
(`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`), not on rows: one Commonly Slack
app, many workspaces. `SLACK_APP_TOKEN` / `SLACK_BOT_TOKEN` in `.env.example` belong to the legacy
Socket Mode path and are not read by this design.

### 2c. Routing details that are Slack-shaped (D10–D12 applied)

- **Threads are D11's native fit.** Relayed lines post top-level in the DM with `[PodName]`; the
  relay map stores `{ externalMessageId: ts, agentUsername, podMessageId, podId }` — Telegram's
  `tgMessageId` becomes the generic `externalMessageId` (Telegram's writer keeps writing both until
  the map is migrated; readers prefer the generic key). An inbound event with `thread_ts` equal to a
  mapped `ts` is the quote-reply: route to that agent in that pod. A bare DM follows D12's
  precedence with the ack line.
- **Commands.** Slack intercepts unregistered `/words`, so the control plane (#1301's `/mode`,
  `/mute`, `/unmute`, `/status`, `/tldr`, `/help`) is one registered slash command, `/commonly
  <sub>`, delivered to `POST /api/webhooks/slack/commands` (same signature check). No enable
  command exists for Slack; the callback replaced it. The #1287 question (who may reconfigure) is
  answered by construction in the DM: only the bound `slackUserId` reaches it.
- **Outbound.** `slackBridgeService.relayAgentMessageToSlack` registered as `internal:slack.relay`,
  same payload as Telegram's handler plus the selected `integration`; it validates provider, pod,
  active, live-relay, `chatType === 'im'`, `chatId`, resolves the token through the ref, and posts
  with `chat.postMessage`. Escalation gating (`shouldEscalate`) is lifted into a shared helper so the
  two bridges cannot drift.
- **The dispatcher stops naming Telegram.** `activeTelegramHandlersForPod` in
  `installable/eventHandlers.ts` matches `type: 'telegram'`; it becomes `type: { $in:
  registeredProviders }` (or drops the type match and lets the parent's component decide), and the
  legacy-row fallback (`installationId` absent) stays Telegram-only because only Telegram has legacy
  live-relay rows. This is the one change to #1527's code that Slack forces; it is additive.
- **Ack fast, dedupe, expect retries.** Slack retries any event not acknowledged within 3 s and
  marks retries with `X-Slack-Retry-Num`; the events route acknowledges immediately and processes
  after the response, and dedupes on `event_id` (a small TTL set, or a unique index on
  `config.messageBuffer.externalId` is not enough — dedupe is at the event, before relay). Telegram
  has no equivalent; this is new verification surface for Vera.

### 2d. The #1527 invariants, checked one by one

Vera's list (pod, 2026-09-04): identity-derived install and uninstall targets; one live parent per
`(installableId, targetType, targetId)` across the partial index; every owner write fenced on the
claim generation; mint-last, with the bearer secret minted inside the activation CAS; the routing
row deciding the bound target; the dispatcher selecting before any handler runs. Slack keeps all
six unchanged — `installableId: 'slack'` is a second key in the same index, so a user may hold one
Telegram and one Slack install, never two of either.

The one place Slack adds to that list rather than reusing it: **a second secret enters at the
callback, outside the activation CAS.** The activation CAS mints the `state` code exactly as it
mints Telegram's; the bot token is not minted by us but *received* from `oauth.v2.access`, and it
is written by the callback the way `handleEnableCommand` writes `chatId` — after the parent is
already `active`. The rules that keep this honest:

- The token is written only after a **single-use `state` redemption with its session nonce**:
  the callback's row CAS is `{ type: 'slack', isActive: true, 'config.connectCode': state,
  'config.chatId': { $exists: false } }` plus the nonce hash, and the exchange is called only
  after that row is found. No secret is stored for a state that has expired, been reused, lacks
  its nonce, or names a row already bound.
- `ConnectorSecret` has a **unique index on `integrationId`** and the callback upserts by it, so
  the secret write is idempotent per row; the callback's second write sets `pendingBind` (with the
  ref) and clears the code in **one write**; the owner's Confirm is the third, identity-derived,
  and the only one that makes the row route. A crash between the first two leaves an orphan
  `ConnectorSecret` with no ref and an unconsumed code — *New code* re-mints, the next callback's
  upsert overwrites the orphan, and the reconciler deletes any `ConnectorSecret` whose Integration
  is inactive, absent, or has neither a ref nor a pending bind. An unconfirmed bind is revoked
  after 10 minutes by the same sweep.
- **The bind is confirmed by the Commonly identity, not proved by the Slack one.** The callback
  proves *a* Slack identity; only the authenticated owner (the same derivation install and
  uninstall use) can accept it, and the card shows the workspace and user being accepted.
- Uninstall's unproject revokes the ref in the same step that deactivates the row (identity-derived,
  as today), so a stale owner reviving after revocation finds no token to send with even if it
  finds a row.

Nothing else moves: the parent's generation fence, `boundPodId`, the sweep, and the dispatcher's
selection are byte-for-byte #1527's.

## 3. Manifest

```jsonc
{
  "installableId": "slack",
  "name": "Slack",
  "description": "Link your Slack DM to Commonly — every pod you're in gets a voice where you already talk.",
  "version": "1.0.0",
  "kind": "app", "source": "builtin", "scope": "user", "status": "active",
  "requires": ["chat:read", "chat:write", "integrations:manage"],
  "components": [
    { "name": "slack-webhook", "type": "webhook",
      "webhookPath": "/api/webhooks/slack",
      "webhookEvents": ["message.im", "oauth.callback", "command"],
      "addresses": [{ "mode": "webhook", "identifier": "/api/webhooks/slack" }],
      "scopes": ["chat:write"] },
    { "name": "slack-relay", "type": "event-handler",
      "eventType": "chat.message", "eventHandler": "internal:slack.relay",
      "addresses": [{ "mode": "event", "identifier": "chat.message" }],
      "scopes": ["chat:read"] }
  ]
}
```

Slack app manifest (operator side, documented in `docs/slack/README.md`): bot scopes `im:history`,
`im:write`, `chat:write`, `users:read`, `commands`; events `message.im`; request URLs
`/api/webhooks/slack/events`, `/api/webhooks/slack/commands`; redirect URL
`/api/webhooks/slack/oauth/callback`; distribution enabled so any workspace can install.

## 4. The flow, end to end

Add a channel → pick a pod → `POST /api/installables/slack/install {podId}` → 200 with the pending
row (or 202/409 as today) → card shows *Authorize in Slack* (link from `authorize-url`) → Slack
consent → callback stores the token behind the ref and a pending bind → card shows "workspace X
wants to connect as @user — Confirm / Not me" → Confirm binds team, user, DM → card flips to
*Connected · Relay on* → first outbound `[PodName] connected` lands in the DM → a reply in the DM
lands in the pod as the linked user. Disconnect → `DELETE /api/installables/slack/install` →
unproject deactivates the row, clears the code, revokes the ref → `uninstalled`.

## 5. Security carry-over and additions

Everything in the Telegram plan's §7, plus: the callback is rate-limited with the integrations write
limiter (it mints nothing but it binds); `state` and its nonce are verified before `oauth.v2.access`
is called, so an attacker cannot spend our exchange budget with forged states; the callback path is
excluded from query-string logging at the ingress and the app (the `state` must not land in a log); the exchange response is never logged;
the token is written only through `connectorSecrets.put`; `botTokenRef` is server-owned; events and
commands verify the signature on the raw body with a 5-minute timestamp window; `channel_type` must
be `im` for inbound relay, mirroring #1289.

## 6. Acceptance seeds (Vera owns the plan)

1. Install → pending row with a code and no team/chat; `authorize-url` embeds that code as `state`
   and refuses a non-owner.
2. Callback with an unknown, expired or reused `state` → 4xx, nothing written, no exchange call
   (spy on the Slack client).
3. Callback with a valid `state` **and** its nonce → exchange once, `ConnectorSecret` written,
   `pendingBind` set with the ref, code cleared, row still not routing (`chatId` unset,
   `status` pending); `botToken` absent from the row and from every API response. The same
   `state` without the nonce cookie → 4xx, no exchange. Confirm by the owner → bound (`teamId`,
   `slackUserId`, `chatId`, `chatType: 'im'`, `status: 'connected'`). Confirm by another
   authenticated user → 404, nothing changes. Reject → ref revoked, bind cleared. Unconfirmed for
   10 minutes → swept, ref revoked.
3b. **The leaked-state walk.** Attacker holds a victim's `state` inside the TTL, has no nonce
   cookie → callback refuses. Attacker somehow has both → a pending bind naming the attacker's
   workspace appears on the victim's card; nothing routes; the victim's *Not me* revokes it and
   no inbound was ever authored as the victim.
4. Inbound `message.im` for the bound team+channel → one pod post authored as `linkedUserId`;
   `channel_type: 'channel'` → dropped; unsigned or stale-timestamp request → 401; a retried event
   (same `event_id`, `X-Slack-Retry-Num: 1`) → no second post.
5. Dispatcher: a post in the gate pod → one `chat.postMessage` with the workspace token to the
   bound DM, `[PodName]` prefixed; two users with Slack installs on the same pod → two sends;
   a Telegram install and a Slack install on the same pod → one send each, each with its own
   handler (the dispatcher no longer names Telegram).
6. Thread reply on a relayed `ts` → routed to that agent in that pod (D11); bare DM → D12 path.
7. Uninstall → row inactive, ref revoked, `ConnectorSecret` gone; reinstall creates a new row and
   a new ref.
8. **Stranger smoke.** From a workspace Commonly has never seen: Add a channel → Authorize → the
   `[Pod] connected` line arrives in the DM → a reply lands in the pod within the same sitting.
   The measure is the same as the Telegram milestone's: unassisted, one sitting, time to first
   round trip.

## 7. Sequence and sizes

| Piece | Owner | Size |
|---|---|---|
| `connectorSecrets` module + `CONNECTOR_SECRET_KEY` wiring + tests (D6) | Kai | S |
| Slack manifest + seeder entry; dispatcher type generalisation | Kai | S |
| `authorize-url` (nonce cookie), OAuth callback (pending bind), confirm/reject routes, events + commands routes with signature/ack/dedupe | Kai | M |
| `slackBridgeService` (outbound, inbound, thread router) + shared escalation helper | Kai | M |
| Page: Slack tile enabled, *Authorize in Slack* affordance, copy | Kai | S |
| Slack app manifest + `docs/slack/README.md` rewrite; env in `api-keys` | Kai + operator | S |

Order: D6 module first (it is the prerequisite), then manifest + dispatcher, then routes, then
bridge, then page. One backend PR, one page PR, stacked.

## 8. Not decided here

- Channel (team-group) binding for Slack — D7's case, blocked on per-sender attribution as for
  Telegram groups.
- Replacing the legacy per-row Slack ingest provider; it keeps working for its rows and is retired
  when ADR-025 D4 lands.
- The Commander (D16) speaking through the Slack DM — same design as Telegram, lands with D16.
- iMessage — a desktop-runtime spike, separately.
