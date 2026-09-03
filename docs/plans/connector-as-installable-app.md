# The connector as an installable app — implementation spec (TASK-005, ruling A)

**Status:** Ruled by Sam 2026-09-02 (pod message 62584, decision card 6a9812803f95024de5f7bf4e):
**A — one install verb, two doors; Connectors keeps the page.** This document turns the ruling
into buildable work. Owner of the build: Kai. Design review: Wren. Verification: Vera.
**ADR text:** ADR-025 gains **D17** with the decision below once #1295 (the D8–D16 fold) lands;
this file is the implementation plan D17 points at, not a second decision record.

Evidence behind the ruling: `task-005-connector-as-app-decision.md` (attached in the
Connectors v2 pod, 2026-09-02). The load-bearing facts, re-stated so this plan is self-contained:

1. **No installer reads `components[]`.** `routes/registry/install.ts:108` is agent-only and
   writes `AgentInstallation`; `InstallableInstallation` has zero production writers. ADR-001
   invariant 6 ("one install record → N component projections") is unimplemented for every
   component type. This plan builds it — for two types, against two behaviours that already ship.
2. **The connector already has both components, hardcoded.** Inbound Webhook =
   `routes/webhooks/telegram.ts` (one fixed path, mounted at `server.ts:207`). Outbound
   EventHandler = the `require('./telegramBridgeService')` at `agentMessageService.ts:1787`,
   fired after every agent post. `COMMONLY_SCOPE.md` §4.6 (the Discord bridge) is this exact
   shape, written in April.
3. **The Connectors page is the install surface** (`/v2/connectors`, nav slot, #1290/#1304). The
   Apps marketplace is `MARKETPLACE_LOCKED`, off the rail, and `/api/marketplace/browse` filters
   `source: 'marketplace'` — a builtin app is invisible there. The Browse card is a second door
   that lands when the marketplace unlocks and calls the same verb; nothing here depends on it.
4. **Scope is `user`** (ADR-025 D8, folded and Vera-verified): the private chat binds to the
   user, not to a pod. The pod-scoped connector (D7) is the dormant team-group case and is out of
   scope here.

## 1. The manifest

One builtin Installable, seeded idempotently at boot the way `seed-native-agents.ts` seeds the
first-party apps (§4 below names the seeder). Field names are `models/Installable.ts`'s, not
the prose names in ADR-001.

```jsonc
{
  "installableId": "telegram",
  "name": "Telegram",
  "description": "Link your Telegram chat to Commonly — every pod you're in gets a voice where you already talk.",
  "version": "1.0.0",
  "kind": "app",            // Apps aisle, verb "Install" (ADR-001 §3.8)
  "source": "builtin",
  "scope": "user",          // ADR-025 D8 — one install per user, never per pod
  "status": "active",
  "requires": ["chat:read", "chat:write", "integrations:manage"],
  "components": [
    {
      "name": "telegram-webhook",
      "type": "webhook",
      "webhookPath": "/api/webhooks/telegram",
      "webhookEvents": ["message", "edited_message"],
      "addresses": [{ "mode": "webhook", "identifier": "/api/webhooks/telegram" }],
      "scopes": ["chat:write"]
    },
    {
      "name": "telegram-relay",
      "type": "event-handler",
      "eventType": "chat.message",             // NativeAgentTrigger's name — no third vocabulary
      "eventHandler": "internal:telegram.relay",
      "addresses": [{ "mode": "event", "identifier": "chat.message" }],
      "scopes": ["chat:read"]
    }
  ]
}
```

Rules the manifest carries:

- **No credential in the row.** The bot token stays in env (today) and behind H3's reference
  (tomorrow). `requires` declares grants; it never carries material. (ADR-025 D6.)
- **`eventType` reuses `NativeAgentTrigger`'s `chat.message`.** Two vocabularies exist for one
  idea (the closed trigger union that is live, and the open `event-handler` string that is dead);
  this plan adds the first real event-handler dispatch and must not add a third name. Unifying
  the two is named as follow-up, not done here.
- **Provider truth stays in the registry.** `backend/integrations/manifests.ts` remains the
  source for `configSchema` / `capabilities`. The Installable is the *package*; the provider
  manifest is the *driver contract*. The seeder derives display fields from the registry entry
  so the two cannot drift (ADR-025 D4's direction: registry wins).

## 2. The install verb

**`POST /api/installables/:installableId/install`** (auth; rate-limited with the integrations
write limiter's key function). Body: `{ podId }` in Phase 1 (see §5), nothing else that the
server owns.

What it does, in order — this is `installableInstallService.install()`:

1. Load the Installable; 404 if absent or not `active`.
2. Resolve the target from `scope`: `user` → `targetType: 'user'`, `targetId: req.user.id`.
3. **Claim the parent atomically — the claim is the compare-and-set** (the #1315 shape; Kai's
   ask, 2026-09-02). One row per `(installableId, targetType, targetId)` across every
   non-uninstalled state: a **unique partial index filtered to `status: { $in: ['installing',
   'activating', 'uninstalling', 'active', 'error'] }`**. The service never reads-then-writes. It runs one
   `findOneAndUpdate` with `upsert: true` whose filter is the key plus **one of**: no row;
   `status: 'error'`; or `status: { $in: ['installing', 'activating'] }` with `claimedAt <
   now − INSTALL_LOCK_TTL_MS`
   — and whose update sets `status: 'installing'`, **`claimId: randomUUID()` — a fresh
   generation on every claim and every takeover**, `installedBy`, `installableVersion`,
   `installSource: 'ui'`, `grantedScopes = installable.requires` (**descriptive only in Phase 1**
   — it records what the manifest declared at install time, mirroring ADR-001's "declared,
   permissive enforcement"; nothing reads it for authorization, and no route may start to
   without a decision that says so), `claimedAt: now`. So a
   retry after a failed install **claims the retained `error` row** instead of inserting
   beside it, a first install inserts, and **a lock whose owner died mid-projection is taken
   over, not honoured forever** (Vera, 2026-09-02: a lock with no expiry left that user unable
   to install again — every retry hit the loser path). The document returned with **our** `claimId` is
   the lock (its `status` tells the owner where to resume: `installing` → run projectors;
   `activating` → skip projectors, resume at step 6 write 2); **only the lock owner runs projectors, and
   every write the owner makes is fenced on that generation** (step 6). `INSTALL_LOCK_TTL_MS`
   is one named constant — 60 s — and it is a **liveness** parameter, not a safety one: it
   decides how soon a user who saw a 202 gets a real install on retry. Safety is the fence.
   A takeover during a GC pause is therefore harmless: the paused owner revives holding a
   generation the row no longer carries, and its writes are refused (Kai 62654, Vera 62655 and
   62701, 2026-09-02 — the first lease cut had the takeover and not the generation, and the
   walk was: A stalls, B takes over and mints C_B, A revives and mints C_A over it, the user
   types C_B and gets "Invalid code" with nothing logged). Any other outcome is the loser's path and never invokes a projector: the
   existing row is returned as-is — **202 while `installing` or `activating`** (the owner will finish it),
   **200 when `active`**. A duplicate-key error on the upsert (two first-installs racing the
   insert) is the same loser's path. `uninstalled` rows sit outside the index, so re-install
   after uninstall inserts fresh and mints a new Integration row (the binding row is the unit).
   One parent therefore means one projected row (`Integration.installationId` is unique), and
   `findLiveIntegration(podId)` never sees two live rows born from one user's install.
4. **Iterate `components[]`** — as the lock owner, with every parent mutation fenced:
   component status and `projectionIds` are written with `findOneAndUpdate({ _id, status:
   'installing', claimId: ours }, …)`, and a `null` result is **`InstallLockLostError`**, which
   aborts the install without touching the Integration row. For each component, look up
   `projectors[component.type]` (§3). Missing
   projector → that component's `status: 'error'` with a message naming the type; the parent
   ends `status: 'error'` and the install returns 422 with the parent row — **the row is kept**
   so the half-install is visible (COMMONLY_SCOPE §5 "partial failure visibility"), and a retry
   is idempotent.
5. Each projector returns `projectionIds`; the service writes them onto the component entry and
   sets it `active`.
6. **Activate last — mint last — and fence both.** Only when every component is `active`
   does the service activate. The parent and the projected row are two documents, so the
   activation is a **split commit**, and the split is bridged by a recoverable state rather
   than pretended away (Kai 62709, 2026-09-03: with `active` written before the mint, a crash
   between the writes made every retry return 200 with no code). Three writes, order
   load-bearing:
   1. **Parent CAS on the generation → `activating`:** `findOneAndUpdate({ _id, status:
      'installing', claimId: ours }, { $set: { status: 'activating', activatedByClaimId:
      ours } })`. The `claimId` term is **required in the filter, never match-if-present** —
      this is the write that commits to handing out a bearer secret. `null` ⇒
      `InstallLockLostError`: the owner logs at warn with both generations, mints nothing,
      **does nothing else — no unproject, no status write, no cleanup of any kind** — and
      returns **409 `{ code: 'install_lock_lost' }`** to its own caller. A refusal means
      "someone else owns this row now"; a loser that tidies up deletes the winner's work
      (Vera 62703 — D6's `markPosted` gate made exactly that mistake). The same rule holds
      for every fenced write in step 4: on `null`, stop. The refusal is a distinct error
      class and a distinct status, never the `null` a no-op would return (Vera 62655: D6's
      first cut returned null for both and the caller reported success). `activating` is a
      live state: it sits inside the unique index and inside the claim filter (lease takeover
      applies), and **the idempotent-return path never treats it as success** — a retry or a
      takeover that finds `activating` skips the projectors and resumes at write 2.
   2. **Integration activation, fenced on its own state:** `findOneAndUpdate({ installationId:
      String(parent._id), isActive: false }, { $set: { isActive: true, 'config.connectCode':
      …, 'config.connectCodeExpiresAt': … } })` — `mintConnectCode()` is called exactly once,
      inside this write's construction. `null` here means the row is already active (a
      resume after a crash between writes 2 and 3): read the existing code, mint nothing.
   3. **Parent CAS → `active`:** `findOneAndUpdate({ _id, status: 'activating', claimId:
      ours }, { $set: { status: 'active' } })`, fenced like every other owner write; `null` ⇒
      `InstallLockLostError`, do nothing (the row's code, if any, belongs to whoever holds
      the generation now).
   Until write 2 the Integration row exists with `isActive: false` and **no code**; until
   write 3 the parent is `activating`, and **only `active` ever returns 200 with a code.**
   This is what makes a partial install safe without touching the enable path:
   `handleEnableCommand` looks up `{ type, isActive: true, 'config.connectCode' }` on main and
   knows nothing about installations — a 422'd install therefore has nothing it can find. A
   retry of the install reuses the inactive row and activates it; the reconciler treats an
   inactive row under an `error` parent as expected, not stale. (Vera, 2026-09-02: "mint
   last, or teach enable the parent status" — mint last, so the route is not edited.)
7. Response: `{ installation, integration }` — the page needs the Integration row (connect code)
   immediately, exactly as it gets it from `POST /api/integrations` today.

**The projection IS the Integration row.** No new projection table. Both components project
onto the *same* `Integration` document, because the connector's runtime state (chat binding,
relay flags, relayMap) is one record today and splitting it would invent a migration for no
behaviour. `Integration.installationId` — already declared with a unique sparse index and
written by nothing — becomes the back-pointer: `String(installation._id)`.

**Prerequisite, and it is a must-fix before the first write lands (@sprint-review, 2026-09-02).**
"Written by nothing" is true of writes only. The field has **two readers**, both in
`backend/routes/discord.ts` on `origin/main`, and this spec is the first writer either has ever
had — so shipping the back-pointer arms both of them in the same commit:

- `:80`, inside `handleInstallationEvent` — `Integration.findOne({ installationId })`, an
  already-installed short-circuit. Its input comes from Discord (`interaction.id`, a numeric
  snowflake) and ours would be a 24-hex ObjectId string, so the value spaces are disjoint and
  this reader stays inert. Stated because it is the explanation that has to be killed, not
  because it is safe by design.
- `:208`, `DELETE /api/discord/uninstall/:installationId` — same `findOne({ installationId })`
  with **no `type: 'discord'` filter**, gated by `canManageIntegration`, body
  `DiscordIntegration.findOneAndDelete` + `Integration.findByIdAndDelete`.
  A **hard delete**, and its id comes from the *caller's* URL, so the disjointness that protects
  `:80` does not reach it. Once a Telegram or Slack connector carries an `installationId`, any
  caller who passes that gate can hard-delete it through the Discord route — bypassing this
  spec's uninstall entirely, which is soft by design ("nothing is deleted", below).

  **That gate is wider than a pod role, and the width is doing the severity work
  (@sprint-review, 2026-09-02).** `canManageIntegration` is three branches in order: first
  `user.role === 'admin'` — an **instance-wide** role on the User row, scoped to neither this pod
  nor this integration; then `integration.createdBy === userId`; then `pod.createdBy === userId`.
  An earlier draft of this bullet glossed it as "pod creator, pod admin, or `createdBy`", which
  was wrong twice: it read the instance role as pod-scoped, and **"pod admin" is not a thing the
  `Pod` model can express** — `members` is a bare `ObjectId[]` with no role path beneath it, and
  the model's only `role` field lives on `agentEnsemble.participants[]`
  (`starter | responder | synthesizer | observer`), a turn-taking value carrying no authority.
  So the pod-scoped half of this gate is `createdBy` alone, and the branch that actually sets the
  blast radius is instance admin.

The convention already exists one route down: `POST /api/discord/register-commands/:integrationId`
returns 400 on `integration.type !== 'discord'`. So the fix is to match it — add the `type:
'discord'` term to the `:208` filter — and it is correct on its own merits, before and
independently of this spec. **Nothing here writes `installationId` until that term is in.**

**Uninstall — `DELETE /api/installables/:installableId/install`:** the target is resolved
**from the caller's identity exactly as install resolves it** — `scope: 'user'` → `targetType:
'user'`, `targetId: req.user.id` — and from nothing else: the route takes no installation id
and no body field, so there is no way to name someone else's row. (Vera, 2026-09-02: install
gated the pod by `isPodMember` while uninstall had no matching gate — a co-member could have
torn down another member's connector.) Revocation is a recoverable split commit: the parent
first becomes **`uninstalling`** under a fresh generation; projectors deactivate their rows and
clear the code; only then does a generation-fenced CAS finalize it as `uninstalled`. The webhook
projection writes a terminal `revokedAt` tombstone before finalization, so an old activation
generation cannot revive a connector after revocation. A fresh concurrent delete gets 202
`uninstalling`, never a false disconnected success; the reconciler deactivates a stale
`uninstalling` projection before it completes the parent. Nothing is deleted; no row → 404.
Uninstalling an `installing` row is allowed and is the human escape hatch for a stuck lock in
addition to the lease. Re-install mints a new Integration row — Vera's
ruling on the design spec stands (the binding row is the unit; relayMap and gates are never
reused).

**The legacy `POST /api/integrations` stays.** It is the pod-scoped path (buffer / summary
integrations, and the dormant D7 connector). Additive, not destructive: the Connectors page
stops calling it for Telegram; nothing else changes.

## 3. The dispatcher — two projectors, one registry

`backend/services/installable/projectors/` — one file per component type, registered in an
index the install service reads. Interface:

```ts
interface ComponentProjector {
  type: ComponentType;
  project(component: IComponent, ctx: ProjectionContext): Promise<Record<string, Types.ObjectId | string>>;
  unproject(component: IComponent, ctx: ProjectionContext, projectionIds: Map<string, unknown>): Promise<void>;
}
// ctx = { installation, installable, installedBy, config }
```

**`webhook` projector (`internal` webhooks only in Phase 1).** For a builtin whose
`webhookPath` is a route this server mounts, projection means: resolve the provider from the
registry by path (`telegram`), and create-or-reuse the Integration row for this installation
with the same server-owned defaults `POST /api/integrations` applies today —
`relayAllAgentMessages: true`, `liveRelay: true`, `linkedUserId = installedBy` (stamped after the
default, the #1297 ordering), `createdBy = installedBy`, `installationId` — **created
`isActive: false` and without a connect code.** The projector never mints: the code is the one
bearer secret in the system and it is minted by the install service's final activation write
(§2 step 6), so no component failure after this projector can leave a redeemable code behind.
Returns `{ integrationId }`. **No new route table**: the route is already mounted; the projector
records the binding, it does not register HTTP. A `webhookPath` the server does not mount is a
projector error (that is the external-webhook case — ADR-006's, not this plan's).

**`event-handler` projector.** `eventHandler: 'internal:<name>'` resolves against an
in-process handler map (`backend/services/installable/eventHandlers.ts`), initially
`{ 'telegram.relay': telegramBridgeService.relayAgentMessageToTelegram }`. Projection records
`{ integrationId }` (shared with the webhook projector — same row) and marks the handler
subscribed for this installation. **The dispatch replaces the hardcoded `require`** at
`agentMessageService.ts:1787`: the message service calls
`eventHandlers.dispatch('chat.message', payload)`. **Selection is the dispatcher's, and it is
scoped by the event's target — never "every active handler for this event type."** The
dispatcher's selector for `chat.message` in pod P resolves the installations whose projection
is bound to P: in Phase 1 that is one query, `Integration.find({ installationId: { $exists },
isActive: true, 'config.liveRelay': true, podId: P })`, joined to their parents — the same O(1)
cost the hardcoded hook has today (the comment at `agentMessageService.ts:1783` promises that,
and the promise moves up a layer with the call). The dispatcher then invokes each selected
handler with the same payload the bridge takes today (`{ podId, agentUsername, displayName,
content, podMessageId }`) plus the selected `integration`, fire-and-forget, one `try/catch` per
handler so one bridge cannot fail the post. The bridge's own `findLiveIntegration(podId)` stays
in Phase 1 as defence in depth, not as the selector: an install must be filtered out **before**
its handler runs, not inside it — a dispatcher that fans out to every tenant and relies on each
handler to decline is a multi-tenant leak waiting for a handler that does not (Vera,
2026-09-02). In Phase 2 the selector becomes D8's inversion — pod → members → each member's
user-scoped install — and the bridge lookup is deleted; the handler signature does not change.

**Behaviour pins:** (a) for a pod with one live Telegram row, exactly one relay fires per post,
with the same arguments as before; (b) **two tenants**: user A's install bound to pod P and
user B's bound to pod Q — a post in P invokes A's handler once and B's zero times, measured at
the dispatcher (a spy on the handler map), not at the bridge; (c) a pod with no install costs
one selector query and zero invocations. Those are the tests that prove invariant 6 landed
without moving the product or widening it.

Unknown `eventHandler` prefix (`agent:`, `webhook:`) → projector error in Phase 1. Those are
the slash-command / external-webhook tracks; naming them here keeps the enum honest.

**Reconciler.** A boot-time sweep (`installableReconciler.sweep()`), idempotent: for every
`active` installation, every component's `projectionIds` must resolve to a live row; a missing
row marks the component `stale` (never re-creates silently — a stale connector must not mint a
code nobody asked for). For every `uninstalled` installation, projections must be inactive.
For every **`installing`** installation whose `claimedAt` is older than `INSTALL_LOCK_TTL_MS`,
the sweep sets `status: 'error'` with `errorMessage: 'install lock expired'` — fenced on the
`claimId` it read, so it cannot race a takeover that happened between its read and its write
— and the row becomes the ordinary retryable case, and the board-facing state stops lying
about work in progress. For a stale **`activating`** installation the sweep must **look
before it demotes**, because write 2 may already have run (Vera, 2026-09-03, on the merged
text: an unconditional demotion strands a live, redeemable code under an `error` parent): if
the projected Integration row is `isActive: true` with a code, the sweep **finishes** the
install — write 3, `activating → active`, fenced on the `claimId` it read — so the code the
user was handed is the code the row reports; only if the Integration row is still inactive
does it demote to `error` as above. The sweep never mints and never unprojects; it only ever
completes or demotes, and both writes are fenced.
The sweep is the backstop; the claim filter above is the primary path, so a stuck lock is
recoverable by the next install attempt even between sweeps.
Log a count line, the H3 pattern: the exit condition is the number reaching zero.

## 4. Seeding

`backend/scripts/seed-builtin-connectors.ts`, run from the same boot hook as
`seed-native-agents.ts`. Upserts the manifest in §1 keyed on `installableId`, `$set`s display
fields from the provider registry entry, `$setOnInsert`s stats. It does **not** create
installations — a builtin app is available, not installed, until a user installs it. (This is
where the seeder differs from the first-party agents, which are also auto-installed into the
demo pod; a connector auto-installed for every user would mint connect codes nobody asked for.)

## 5. Phasing — what changes now, what waits for D8's schema

ADR-025 D8's three schema consequences are unbuilt (`Integration.scope` does not exist;
`podId` is `required: true`; `findLiveIntegration(podId)` resolves from the pod and cannot see a
row without one). This plan does not gate on them; it lands the install substrate first and
makes D8's flip a projector change.

**Phase 1 — install substrate (this plan).** Installation is user-scoped (`targetType: 'user'`,
one per user). The projected Integration row keeps today's pod binding: the page's pod picker
becomes the **first gate row**, and its pod is written to `Integration.podId` — the "active pod"
of D12, honestly labelled as the single pod this connector relays until D8 fans out. Relay
behaviour is byte-for-byte today's. The `Integration.podId` write on install is gated by
`isPodMember(pod, installer)` — the #1297 write gate, reused.

**Phase 2 — D8's schema (separate PR, after this lands).** `Integration.scope: 'user'`,
`podId` optional under a conditional validator, `config.gates[podId]`, and the outbound lookup
inverted to pod → members → each member's personal connector. The projectors do not change
shape; only what they write does. The install verb's API does not change at all.

Phase 1 is honest about D8 without pretending to have built it: the Installable declares
`scope: 'user'` because that is what the product is, and the one place the schema still says
"pod" is the gate row the user picked.

## 6. The page

`V2ConnectorsPage.tsx`, "Add a channel" (`createTelegram`, line ~131): the POST moves from
`/api/integrations` to `/api/installables/telegram/install` with `{ podId }`. Everything
downstream reads the same Integration row it reads today (`/api/integrations/user/all`), so
the code step, the polling, the expired-code re-mint (#1297), the relay/mode toggles, and
disconnect are unchanged — except **disconnect** calls the uninstall verb instead of
`PATCH isActive: false`, so the parent row's lifecycle stays true.

Card copy does not change. The design spec (rev 5, §2.1–2.4) already describes a personal
connector card with pod gates beneath it; Phase 1 renders one gate row (the picked pod),
Phase 2 renders them all.

**Browse card (later, not this plan):** `V2MarketplacePage`'s Install button posts
`agentName` to `/api/registry/install` for every kind — it must branch on `kind === 'app'`
to the install verb above before any app is listed there. That branch is a one-line seam this
plan leaves for the marketplace-unlock PR, and the `/browse` filter must admit `source:
'builtin'` for the card to exist at all.

## 7. Security carry-over (from #1297, none of it optional)

- `linkedUserId` is stamped from the installer, after the relay default, never from the body.
- Connect code is minted server-side (`mintConnectCode`); the body cannot supply one, and it
  is minted only by the final activation write — never by a projector (§2 step 6).
- The chosen pod is gated by `isPodMember` (write predicate, no admin read-bypass).
- Install and uninstall both resolve their target from the caller's identity; neither accepts
  an installation id or a target from the body, so a caller can only ever act on their own row.
- `grantedScopes` is descriptive, not enforced (Phase 1). Authorization is `auth` +
  `isPodMember` + identity-derived targets, nothing else.
- The install and uninstall verbs sit behind the integrations write limiter's shared key.
- The Installable row carries no secret; H3's credential reference is the only future home.
- Enable-time refusal of a group bind, the string-`'true'` coercion, and the attempt limiter
  are untouched — they live on the webhook route, which this plan does not edit.

## 8. Acceptance — what Vera verifies

Unit (`backend/__tests__/unit/services/installable/`):
1. `install('telegram')` creates one parent row with two component entries, both `active`,
   both pointing at the **same** `integrationId`; the Integration row has `installationId ===
   String(parent._id)`, `linkedUserId === installer`, a 32-hex code with expiry, `liveRelay` and
   `relayAllAgentMessages` true, `podId` = the gated pod.
2. A second install by the same user returns the existing row — 200 when active, **202 while
   installing** — creates nothing and **invokes no projector** (spy on the projector registry).
   **Two concurrent installs** (fire both before either resolves, real Mongo via
   mongodb-memory-server so the unique index is exercised) produce exactly one parent, one
   Integration row, one code, one set of projector calls; the loser gets the winner's row. A
   retry after a 422 **claims the retained `error` row** (same `_id`), never a second parent.
3. A manifest with an unknown component type yields parent `error`, the row kept, 422 —
   **and the projected Integration row is `isActive: false` with no `connectCode`**, so
   `handleEnableCommand`'s lookup cannot match it (assert `Integration.findOne({ type:
   'telegram', isActive: true, 'config.connectCode': { $exists: true } })` is null for that
   installation). A retry that succeeds activates the same row and mints once.
4. `uninstall` sets parent `uninstalled`, Integration `isActive: false`, code fields unset,
   relayMap preserved.
4b. **Uninstall is identity-scoped.** User B, a member of the same pod as user A's connector,
   calls `DELETE /api/installables/telegram/install`: A's row is untouched (B gets 404 with no
   install of their own, or uninstalls only their own). A body containing another
   installation's id changes nothing.
4c. **Revocation never reports success ahead of its projection.** A projector failure or crash
   after the parent enters `uninstalling` leaves the parent recoverable, not `uninstalled`; the
   Integration becomes inactive with no code before a sweep or retry can finalize it. A stale
   sweep deactivates first and then fences the `uninstalling → uninstalled` transition; the
   terminal tombstone prevents an old activation generation from reviving the Integration.
5. Non-member of the chosen pod → 403, nothing written.
6. Reconciler: a deleted Integration under an active installation marks the component `stale`,
   creates nothing. An `installing` row with `claimedAt` older than the TTL is swept to
   `error` with `'install lock expired'`. A stale `activating` row whose Integration is still
   inactive is swept to `error`; a stale `activating` row whose Integration is already active
   with a code is **completed to `active`**, the code unchanged, `mintConnectCode` not called
   — never demoted, so no redeemable code ever sits under an `error` parent.
6b. **Lock takeover.** An `installing` row with a stale `claimedAt` (owner died): the next
   install claims it (same `_id`, new `claimId`, new `claimedAt`, new `installedBy`), runs
   projectors, reuses the inactive Integration row, activates and mints exactly once. A fresh
   `installing` row (within the TTL) is not taken over — the second caller gets 202.
6c. **Stale-owner completion is a refused no-op, and it is visible.** A claims (generation
   `a`) and stalls; B takes over (generation `b`), activates, mints `C_B`. A revives and runs
   its activation is refused with `InstallLockLostError`, **no second code is stored**, **no
   `unproject` call happens and A writes nothing** (spies on the projector registry and on the
   `Integration` model: B's writes only), the Integration row still carries `C_B` and stays
   `isActive: true`, and A's caller receives 409 `install_lock_lost` — asserted on the status
   and the code, not on a null.
6d. **The split commit is recoverable, never reported as success.** (i) B crashes between
   writes 1 and 2: the parent is `activating`, the Integration row inactive with no code. A
   retry within the TTL gets **202**, not 200 — never 200-with-no-code. After the TTL the
   next attempt takes over (new `claimId`), finds `activating`, runs no projector, performs
   write 2 (mints once) and write 3, returns 200 with the code. (ii) B crashes between writes
   2 and 3: the code exists on an active Integration row under an `activating` parent; the
   takeover's write 2 returns `null`, the existing code is read, write 3 completes,
   `mintConnectCode` called exactly once across the whole test. (iii) The enable path cannot
   redeem in (i) — no code exists — and in (ii) the code is the one the retry hands back, so
   the user never holds a code the row does not.

Service (`__tests__/service/`):
7. **Behaviour pins, at the dispatcher.** (a) An agent post into a pod with one live Telegram
   row triggers exactly one `relayAgentMessageToTelegram` call via the dispatcher, with the same
   five fields the hardcoded hook passed. (b) **Multi-tenant:** two active installs — user A's
   bound to pod P, user B's bound to pod Q — and a post in P: A's handler is invoked once, B's
   zero times, asserted on a spy at the handler map (the bridge's own lookup is stubbed out so
   it cannot be what filtered B). (c) A pod with no install: one selector query, zero
   invocations. (d) A throwing handler does not fail the post.
8. `telegramBridgeService.attribution` and `telegram.webhook.*` suites pass unchanged — the
   route is not edited.

Frontend (`V2ConnectorsPage.test.tsx`):
9. "Add a channel" posts to `/api/installables/telegram/install` with `{ podId }`.
10. Disconnect calls the uninstall verb.

Lint: `npm run lint:ts` 0 errors (the CI gate). New `.js` tests inherit the known-red corpus;
do not add `global-require` inside test bodies (hoist, per #1297).

## 9. Sequencing and sizes

| Step | Depends on | Owner | Size |
|---|---|---|---|
| ADR-025 D17 amendment (the decision text + pointer here) | #1295 merged | Wren | S |
| Projector interface + registry + install/uninstall verbs + seeder (§2–4) | #1297 merged (reuses its helpers) | Kai | M |
| Event dispatcher replacing the hardcoded hook + behaviour pin (§3, test 7) | same PR or next | Kai | S |
| Page: install verb + uninstall verb (§6) | verbs live | Kai | S |
| Reconciler + tests 1–6 | projectors | Kai | S |
| D8 schema flip (Phase 2) | all of the above | Kai, Wren for the gate UI | M |
| Browse card + `kind` branch + builtin filter | marketplace unlock (a marketplace ruling) | — | S |

Two PRs is the intended shape: (1) verbs + projectors + seeder + dispatcher + tests,
(2) the page. The ADR amendment is its own docs PR.

## 10. Not decided here (named so nothing inherits them silently)

- Slash-command components for `/mode` `/status` `/mute` `/unmute` `/tldr` `/help` — the
  handlers stay hardcoded in the webhook route until the slash-command track (paused, ADR-011)
  reactivates. The command-handler group gate (#1287) is a route fix, independent of this.
- Unifying `NativeAgentTrigger` and `event-handler` vocabularies — this plan reuses the
  trigger name and stops there.
- External webhooks (`webhook:https://…`) and `agent:` handlers — the ADR-006 path.
- Whether `'skill'` should be added to `ComponentInstallation.componentType` (it is missing
  from the enum, pre-existing) — note filed; not this PR.
- The marketplace unlock and the Browse aisle — a marketplace ruling; the seam is left ready.
