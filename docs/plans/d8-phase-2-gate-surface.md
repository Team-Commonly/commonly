# D8 Phase 2 — the gate surface and the capability catalog

**Row:** TASK-009 (Wren, design) → Vera's verification plan → Kai builds. **Builds on:** the install substrate (#1527), the page on it (#1531), Slack as the second connector (#1537/#1538), and the Signal artboard diff for the page ([`connectors-page-signal-diff.md`](connectors-page-signal-diff.md), #1542). **Decides:** ADR-025 D8's schema flip that [`connector-as-installable-app.md`](connector-as-installable-app.md) §5 deferred as "Phase 2", plus the two things the artboard diff named as missing from the kernel (§4 there): which providers an instance offers, and what a parent row in a non-active state looks like.

**Rule carried over:** the page never renders a control the server does not enforce, and never a fact the server does not hold. Every action below maps to a verb that exists today; the one new read (§2 D1) is the point of the note.

## 1. Three facts the page cannot see today

1. **Parent state is invisible.** There is no `GET` on `/api/installables`. The page lists `Integration` rows from `/api/integrations/user/all` and infers the parent from `installationId`. A parent whose projection failed (`status: 'error'`, no Integration row), whose lock expired (`errorMessage: 'install lock expired'`), or whose Integration went missing (`components[].status: 'stale'`) shows **nothing** — and the next Connect returns a typed 409 the user cannot act on. The invisible-error class we closed inside the substrate is still open at the surface.
2. **The page carries the provider list.** `ADD_PLATFORMS` in `V2ConnectorsPage.tsx` says Telegram and Slack are self-serve. The instance knows better: Slack is self-serve only if `slackOAuthService` and the `ConnectorSecret` key ring are configured, Telegram only if the bot token is. A self-hosted instance without Slack secrets shows an *Authorize in Slack* button that fails at `authorize-url` with a configuration error. Vera asked for the flag at 63278.
3. **One pod per connector.** `Integration.podId` is required and is the single pod the connector relays. ADR-025 D8 says the private chat is the user's attention surface for **every** pod they are in, gated per pod. Phase 1 wrote the picked pod as "the first gate row" and stopped.

## 2. Decisions

**D1 — A capability catalog: `GET /api/installables`.** Authenticated. One entry per builtin connector Installable (today: `telegram`, `slack`), shaped for the page:

```json
{
  "installables": [
    {
      "installableId": "slack",
      "label": "Slack",
      "description": "Link your Slack DM to Commonly — every pod you're in gets a voice where you already talk.",
      "available": false,
      "unavailableReason": "not_configured",
      "installation": null,
      "integration": null
    },
    {
      "installableId": "telegram",
      "label": "Telegram",
      "description": "…",
      "available": true,
      "installation": {
        "status": "error",
        "errorMessage": "install lock expired",
        "boundPodId": "66f…",
        "claimedAt": "2026-09-04T20:01:12Z",
        "updatedAt": "2026-09-04T20:02:12Z",
        "components": [{ "name": "telegram-webhook", "status": "stale" }]
      },
      "integration": null
    }
  ]
}
```

- `available` is a **provider readiness check** that lives beside the manifest in `backend/integrations/manifests.ts` (`readiness(): { available: boolean; reason?: 'not_configured' }`), not in the route. Telegram: `TELEGRAM_BOT_TOKEN` present and either `TELEGRAM_SECRET_TOKEN` present or `TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED=true`. Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `CONNECTOR_SECRET_KEYS`, `CONNECTOR_SECRET_ACTIVE_KEY` all present. The response carries the **reason enum only** — never an env var name. Operators read the missing names from the Helm values and `docs/slack/README.md`, not from an API a stranger can call.
- `installation` is the caller's live parent row (`status ∉ {uninstalled}`) with `claimedAt` exposed, because the page's *Cancel* is decided by it (§2 D2). `integration` is the projected row through `publicIntegration` (strips `botTokenRef`, `oauthStateNonce`), or `null`.
- The install verb **refuses an unavailable provider** with `422 { code: 'provider_not_configured' }` before it claims anything. Today Telegram would install and then fail at the webhook; Slack fails at `authorize-url`. Both become one early refusal that matches what the catalog said.
- The existing `GET /api/integrations/catalog` (manifest list + per-pod counts, used by the legacy chat UI) is untouched. It describes the legacy pod-scoped connectors; this route describes user-scoped installables. Merging them is a later cleanup, not this plan.
- The page fetches this one route and polls it while any row is transient or pending; `/api/integrations/user/all` stays only for the legacy rows the page still lists (Discord and friends), rendered as today.

**D2 — Parent states become rows, and their actions are the verbs that already exist.** The page keys its rows by catalog entry, not by Integration row. The row's mark, copy and one action derive from `(available, installation.status, integration)`:

| catalog + parent | integration | dot | line 1 | line 2 (mono) | when | one action |
|---|---|---|---|---|---|---|
| unavailable, no installation | — | dashed `#98a2b3`, name muted | Not enabled on this instance. | `ask your operator` | `—` | none. A link to the provider's docs page is allowed (it is a link, not a claim) |
| available, no installation | — | hollow `#98a2b3` | one sentence from the catalog description | `one message` (Telegram) / `one click in your workspace` (Slack) | `not connected` | **Connect** (ink) → the connect form for that provider (pod picker) |
| `installing` / `activating`, `claimedAt` within `INSTALL_LOCK_TTL_MS` (60 s) | any | cobalt pulsing | Setting up… | `waiting for the server` | `started {rel}` | none |
| `installing` / `activating`, `claimedAt` older than 60 s | any | cobalt pulsing | Setup is taking longer than it should. | `the server let go of it` | `started {rel}` | **Cancel** (bordered) → `DELETE /api/installables/:id/install`. The service already claims a stale transient into `uninstalling`; a live one answers 409 `install_in_progress`, which the page shows as the row going back to *Setting up…*. **No new verb**: Cancel appears exactly when the server would honour it |
| `error` | any | hollow `#98a2b3` | the parent's `errorMessage` as an ink sentence, else "Setup didn't finish." | `retry, or remove it` | `since {rel}` | **Retry** (ink) → `POST …/install { podId: boundPodId }`. The service's claim filter already admits `status: 'error'`; the parent is reclaimed in place, no second row. **Remove** is the bordered secondary in the aside (§2 D4) → `DELETE`, which `claimUninstall` accepts from `error` |
| `active`, Integration present | per [#1542 §2](connectors-page-signal-diff.md) | as there | as there | as there | as there | Manage / Show code / New code / Authorize in Slack / Confirm — unchanged |
| `active`, Integration missing or `isActive: false`, or any `components[].status: 'stale'` | — | hollow | The channel record is gone. | `retry rebuilds it` | `since {rel}` | **Retry** (ink) — same POST; `installAttempt` re-projects. The reconciler's stale-marking (`sweepActive`) is what makes this row honest; it should also set `status: 'error'`, `errorMessage: 'projection missing'` so the parent and the page agree (one-line change in `installableReconciler.ts`) |
| `uninstalling`, within TTL | any | cobalt pulsing | Removing… | `waiting for the server` | `started {rel}` | none |
| `uninstalling`, past TTL | any | cobalt pulsing | Removal is taking longer than it should. | `the server let go of it` | `started {rel}` | **Retry remove** (bordered) → `DELETE` again; `claimUninstall` re-claims a stale `uninstalling` |
| `paused` / `stale` (enum values with no writer today) | any | hollow | Paused. | `not relaying` | `since {rel}` | none until a verb writes these states; listed so the enum has no invisible member |

Copy is final draft in the product's voice; the sentences are the row, the enum value never appears. The first row that needs the user (Connect, Retry, Confirm, Cancel) is the default selection; the aside follows it.

**D3 — Per-pod gates: the D8 schema flip.** `Integration.scope: 'user'` (default `'pod'` for legacy rows), `podId` optional under a validator that requires it when `scope === 'pod'`, and:

```ts
config.gates?: Record<string /* podId */, {
  enabled: boolean;
  mode?: 'attention' | 'mirror';   // overrides config.relayAllAgentMessages for this pod
  lead?: string;                   // overrides config.leadAgentUsername for this pod
  since: Date;
}>
```

- **Outbound inverts:** `findLiveIntegration(podId)` becomes `findLiveIntegrationsForPod(podId)` → pod members → each member's live user-scoped connector (`isActive`, `chatId`, private chat, `liveRelay`) where `gates[podId]?.enabled === true`. One relay call per member with a gate, each through the same `shouldEscalate` with the gate's `mode`/`lead` overlaid. The dispatcher already iterates providers; it now iterates connectors per pod.
- **`podId` stays as the "active pod"** (ADR-025 D12) for bare-message routing; it is no longer what outbound reads. `/pod <name>` keeps writing it.
- **Migration** (`scripts/migrate-connector-gates.ts`, one-shot, idempotent): for every installable-backed row with a `podId` and no `gates`, write `gates[podId] = { enabled: true, since: createdAt }` and `scope: 'user'`. Legacy pod-scoped rows (no `installationId`) are untouched and keep `scope: 'pod'`.
- **Membership is the outer gate.** A gate for a pod the user is no longer a member of is dead weight, not a leak: outbound starts from pod members, so a stale gate never relays. The reconciler prunes gates whose pod no longer lists the user, every 5 minutes, so the aside does not show pods the user left.
- **Install verb API is unchanged.** `POST …/install { podId }` writes the first gate and the active pod. The page's connect form keeps its pod picker.
- **Gate writes:** `PATCH /api/integrations/:id { config: { gates: { [podId]: { enabled } } } }` through the existing PATCH, with the #1297 write gate reused per key: a gate may be written only for a pod the caller is a member of (`isPodMember`). The PATCH already refuses `linkedUserId`; it now also refuses `gates` keys the caller cannot join.

**D4 — The aside gains the gates.** Per #1542 §3 the aside is the selected channel. Its *What the channel sees* card gains one list under the mode controls: one row per pod the user is in (`GET /api/pods` filtered as the pod picker already is — never community/showcase), a 4px ink square mark, the pod name in body text, and a switch. Enabled pods carry mono `since {rel}`; disabled carry muted `off`. Mode/lead overrides stay collapsed behind the row's name (click → the attention/mirror segment and a lead picker for that pod) so the default view is one switch per pod. **Remove** (the bordered secondary that replaces *Disconnect*) sits at the foot of the card with the two-click confirm.

The page renders the gate list **only when the row carries `config.gates`**; a Phase-1 row without it shows today's single "linked to {pod}" line. Feature-detect on data, never on a version.

**D5 — The not-yet row stays page copy.** The artboard's "Discord · WhatsApp — Not yet. Tell us which one you need" row makes no claim about the server and does not come from the catalog. It is the one static row on the page, with *Ask* as a link. A provider enters the catalog the day it becomes an installable.

## 3. Sequence and sizes

| PR | what | size | depends on |
|---|---|---|---|
| A | catalog route + `readiness()` per manifest + install refusal `provider_not_configured` + reconciler `projection missing` | S | — |
| B | page: rows keyed by catalog, D2 state table, Retry / Remove / Cancel wired, poll on the catalog | M | A. **Folds into Kai's Signal restyle (TASK-007)** if that PR is still open — it re-keys the rows anyway; two PRs that both rewrite the row grid is one too many |
| C | D8 schema: `scope`, optional `podId`, `config.gates`, outbound inversion, PATCH gate writes, migration script, reconciler prune | M–L | — (backend only; the page ignores `gates` until D) |
| D | page: gate list in the aside, per-pod overrides, Remove at the foot | S | B, C |

A and C are independent and can run in parallel. B before C is fine: the page shows parents honestly before gates exist.

## 4. Acceptance seeds (for Vera's plan)

1. **Catalog honesty.** Instance with no Slack secrets: `GET /api/installables` says `slack.available: false, unavailableReason: 'not_configured'`; the response body contains no string matching `/SLACK_|CONNECTOR_SECRET/`; `POST /api/installables/slack/install` returns 422 `provider_not_configured` and writes no parent row.
2. **Error row → Retry.** Force a projection failure (projector throws) → parent `error`, no Integration; catalog shows the error row; `POST install` with the same `podId` reclaims the **same** parent `_id` (count of parents for that user stays 1) and reaches `active`.
3. **Cancel is TTL-honest.** Parent stuck `installing` with `claimedAt` 30 s old → `DELETE` answers 409 `install_in_progress`; at 61 s → `DELETE` answers 202 `uninstalling` and the parent's `claimId` changes. The page shows no Cancel at 30 s and shows it at 61 s (the row's `claimedAt` drives it, no client clock trick — inject the clock).
4. **Remove from error.** Parent `error` → `DELETE` → `uninstalled`; the catalog entry returns to `installation: null`; the orphan-secret sweep revokes any `ConnectorSecret` the failed attempt left.
5. **Projection missing.** Delete a live Integration under an `active` parent → the 5-minute sweep marks the parent `error` `projection missing`; catalog shows the row; Retry re-projects with the same `installationId`.
6. **Gates route outbound.** User in pods A and B, `gates[A].enabled: true`, `gates[B]` absent → an escalation in B reaches the channel **zero** times, in A once. Flip B on → once. User leaves A → the prune drops `gates[A]` within one sweep and outbound from A stops immediately (membership is checked at send).
7. **Gate write is membership-gated.** `PATCH` with a `gates` key for a pod the caller is not a member of → 403, no write; other keys in the same body are also refused (all-or-nothing).
8. **Migration idempotent.** Run twice on a mixed set (installable rows with `podId`, legacy rows without `installationId`) → first run writes `gates` + `scope: 'user'` on the installable rows only; second run writes nothing.
9. **Two connectors, one user.** Telegram and Slack both live for the same user with different gates → each pod's escalation reaches exactly the connectors whose gate is on. The `[PodName]` prefix (D10) is unchanged.
10. **Stranger smoke (extends #1535 §6 seed 8).** Fresh instance, only Telegram configured: the stranger sees a Telegram row with Connect, a Slack row that says *Not enabled on this instance* with no button, the not-yet row, and reaches a live Telegram relay in one sitting. Nothing on the page names an env var.

## 5. Not decided here

- Whether admins get a richer catalog (the env names, a "configure" link) — a separate admin surface; strangers never see it.
- Digest cadence per gate (D13 says per pod on a schedule) — the gate object has room for `digestAt`; nothing writes it yet.
- Folding `GET /api/integrations/catalog` into this route once the legacy chat UI stops reading it.
