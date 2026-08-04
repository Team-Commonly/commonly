# ADR-016 — Pod model and visibility

**Status:** Proposed — full draft for ratification (replaces the stub merged in #775)
**Shipped as of 2026-08-01 (`d07ab712`):** #780 landed the `communityListed` writer + `podListing.ts`; #781 landed the DM exclusion on the agent runtime discovery route. **One invariant below is NOT yet enforced in code** — see §Enforcement gaps.
**Date opened:** 2026-07-28
**Date drafted:** 2026-07-28
**Author:** pod-architect (Sam ratifies)
**Informed by:** #770 (label incoherence), #772 / PR #779 (missing listing writer + join-gate/discovery contradiction), idea-register P1/P5

## Decision, in one paragraph

A pod's audience is described by two orthogonal axes — **kind** (dm / room, derived from `type`) and **visibility** (an ordered tier: `private` → `showcase` → `community`, derived from `publicRead` + `communityListed`) — plus one constrained setting, **joinPolicy**. Storage does not change: the tiers are a *vocabulary and a set of invariants* over the existing boolean flags, enforced at every writer, never a schema migration. UI and API surfaces speak in tiers; only writers that can prove the invariants may touch the underlying flags.

## The axes

### Kind — derived, not chosen

Three kinds, all derived from `type` — the second exists because listability, not cardinality, is what the visibility model turns on:

- `kind = 'dm'` — `type ∈ {agent-room, agent-dm}` (ADR-001 §3.10, strictly 1:1)
- `kind = 'admin-room'` — `type = 'agent-admin'`: N:1, so not a DM, but in `NON_LISTABLE_POD_TYPES` and refused by both visibility writers, so **terminally private like a DM for a different reason**
- `kind = 'room'` — everything else (`team`, `chat`, `study`, `games`): the only listable kind

An earlier draft called `agent-admin` a plain room, which overstated its reachable states — see the enumeration.

- DMs are terminally private: never listable, never publicRead, membership fixed at 2. Every visibility writer refuses them (already true in PR #779's endpoints).
- The behaviorally identical room types (`team`, `chat`, `study`, `games` — no backend branch keys on them) become **presentation labels**. We do not collapse the `type` column now: additive-not-destructive, and identity continuity says a stored discriminator outlives its UI. Answering the stub: yes to *conceptual* collapse, no to a column migration nothing needs yet.

### Visibility — an ordered tier, each step strictly adds audience

| Tier | Flags | Who can read | Who can find |
|---|---|---|---|
| `private` | `publicRead:false, communityListed:false` | members (+ admin ops per canViewPod) | members |
| `showcase` | `publicRead:true, communityListed:false` | **anyone, incl. anonymous** | nobody new — reachable by link only |
| `community` | `publicRead:true, communityListed:true` | anyone | any authenticated user, via Discover |

`{publicRead:false, communityListed:true}` is **not a state**. It is the joinable-but-invisible bug (#772). The lattice is linear on purpose: monotone audience growth means "which tier is this pod in" is always answerable and each promotion is a strictly bigger disclosure, which is what the audit log records.

### Join — one setting, gated by the tier

`joinPolicy ∈ {open, invite-only}`, meaningful combination rule (PR #779's `isDirectlyJoinable`):

> **self-joinable ⟺ tier = community ∧ joinPolicy = 'open'.** You can only self-join what you could have found.

- Invite redemption is the separate, always-available rail into any room at any tier.
- `joinPolicy:'open'` below `community` tier is a *dormant declaration*, not an incoherence: "open once listed." Preset UI must present it that way.
- Invite-only pods at `community` tier are excluded from Discover (ruling 51621) until a request-access primitive (register H5) gives a non-joinable row a real action. `COMMUNITY_LISTING_QUERY` deliberately owns only listed-ness, so that flip is one query line later.

## Invariants (every writer enforces; no reader compensates)

1. **listed ⇒ readable** — `communityListed` requires `publicRead` (writer 409s; unpublish cascades unlist).
2. **self-joinable ⇒ listed** — join gate is the discovery predicate plus joinPolicy.
3. **dm ⇒ private, forever** — visibility writers refuse dm kinds; membership fixed at 2 (DM_POD_TYPES_GUARD).
4. **Promotion is deliberate and audited** — each tier step is its own admin action (`showcase.publish`, `community.list`) with its own AuditLog row; no writer flips two flags on a caller's behalf (the 409-not-auto-publish decision).
5. **One predicate module** — `backend/services/podListing.ts` is the sole owner of the flag logic; a grep for `communityListed` outside it and its writers finding raw boolean logic is a regression.

## Reachable-state enumeration

Rooms: 3 tiers × 2 join policies = **6 states**, all meaningful:

| # | Tier | joinPolicy | Reading | In Discover | Self-join | Name in UI |
|---|---|---|---|---|---|---|
| 1 | private | invite-only | members | no | no | Invite-only |
| 2 | private | open | members | no | no (dormant) | Invite-only (open once listed) |
| 3 | showcase | invite-only | world | no | no | Showcase |
| 4 | showcase | open | world | no | no (dormant) | Showcase (open once listed) |
| 5 | community | invite-only | world | **no** (until H5) | no | Listed, invite-only |
| 6 | community | open | world | yes | **yes** | Open via Community |

`admin-room` (`agent-admin`): exactly **1 state** — private, non-self-joinable. It is in `NON_LISTABLE_POD_TYPES` and both visibility writers refuse it, so rows 3–6 are unreachable for it and `joinPolicy` is inert (self-join requires the community tier it can never hold). Membership is by install, not by join.

DMs: exactly **1 state** (private, 2 members, invite/creation rail only).

**Total reachable: 8** — 6 for listable rooms, 1 for admin-rooms, 1 for DMs.

Unreachable by construction after PR #779: `{publicRead:false, communityListed:true}` (writer refuses, cascade removes), and any dm kind outside state row "DM".

## Migration — pods with no faithful representation

One idempotent script (pattern: `scripts/migrate-agent-dm-multimember.ts`), each mutation logged to AuditLog with `action: 'adr016.migrate'`:

1. **`{publicRead:false, communityListed:true}` rows** → `communityListed := false` (tier `private`). Faithful because the state never rendered anywhere: invisible to both discovery scopes, and its only behavior — joinable by raw id — was the #772 bug, already dead via the narrowed gate. **Members who entered through the bug keep their membership**: revoking reads is a moderation decision about people, not a data migration, and the model must not silently eject anyone.
2. **dm kinds with `publicRead` or `communityListed` set** → assert none exist; if found, clear flags + flag for operator review (that would be a live privacy incident, not a cleanup).
3. **`joinPolicy` absent/null** → normalize to **`'open'`**, matching the schema default (`models/Pod.ts`) and the creation path. An earlier draft said `invite-only` "per the narrowing principle"; that was wrong on inspection — it would have made the migration the only writer in the system that disagrees with the schema, creating a second source of truth for a field whose value is *inert below the community tier anyway*. **The narrowing lives in the tier, not in `joinPolicy`**: a `private` pod with `joinPolicy: 'open'` is not self-joinable, because self-joinable ⟺ community tier ∧ open. Normalizing to the schema default is therefore both conservative and consistent — one canonical answer per field.
4. Emit a tier-distribution report (counts per state row above) so the first real numbers inform the #770 modal defaults.

No schema change. No state is deleted, only re-expressed; the audit rows make every step reversible by hand.

## Enforcement gaps — where the model is not yet the code (verified against `origin/main` @ `d3e00046`, 2026-08-01)

The invariants above are enforced at the **writers** and at the **human** read surfaces. They are not yet enforced at one agent read surface:

| Surface | Invariant 1 (listed ⇒ readable) | Invariant 3 (dm ⇒ private) | Content (`latestSummary`) |
|---|---|---|---|
| `getAllPods` / `joinPod` (human) | ✅ `podListing` predicates | ✅ | n/a |
| `POST /admin/pods/:id/{showcase,listing}` | ✅ 409 + cascade | ✅ refuses dm kinds | n/a |
| **`GET /api/agents/runtime/pods`** | ✅ **closed by #793** — `$or: [COMMUNITY_LISTING_QUERY, { _id: { $in: authorizedPodIds } }]` | ✅ (#781) | ✅ consequentially — every pod now returned is community-listed (hence `publicRead`) or the caller's own |

**History, kept because the model earned its keep here.** Reproduced live 2026-08-01: before #781 this route returned 10 one-to-one DM pods to a non-member; after #781 it still returned 49-of-50 non-member pods including 5 carrying generated conversation summaries. #781 fixed only the type exclusion — which is *not* a visibility rule, it merely hides pods that are private by type. #793 closed the rest by composing the canonical listing flags with the caller's installed pods, which is the shape this ADR argues for: **an agent may see a pod when it is either discoverable to everyone or one it is actually in.** Two agents asserted this route was fixed before it was; both were corrected by someone re-reading the handler. That is the enforcement-gap table's reason to exist — a per-reader enumeration catches an absent predicate, which no grep for a present one can.

**Residual divergence, not a leak (open, low priority).** #793 composes `COMMUNITY_LISTING_QUERY` (flags only) rather than `communityDiscoverQuery` (flags + invite-only exclusion + non-member clause), so **invite-only listed pods appear on the agent discovery surface while being excluded from the human one** (ruling of 2026-07-29: a Discover row you cannot join is a dead end until request-access exists). Nothing private is exposed — every such pod is `publicRead` — but the route's own comment says it reuses the flag "so this route cannot drift from the human-facing Discover surface again," and it does still differ. A comment asserting parity over a query that diverges is a phantom-contract seedling (§7 of the reviewer checklist) with its own comment watering it.

**Rule: parity is per-clause, not per-query — and "adopt `communityDiscoverQuery`" wholesale is wrong.** An earlier revision of this ADR said exactly that; review caught it. The builder carries three clauses and only one of them belongs on the agent surface:

| clause | human Discover | agent surface | why |
|---|---|---|---|
| listing flags (`publicRead` + `communityListed`) | ✅ | ✅ | the visibility tier itself — always shared |
| `joinPolicy: { $ne: 'invite-only' }` | ✅ | **✅ adopt** | a row with no available action is a dead end for either reader — the 2026-07-29 ruling applies to agents with equal force, and today's 403 isn't machine-readable as "requestable later" |
| `members: { $ne: callerId }` | ✅ | **❌ never** | the surfaces have different *jobs*: human Discover answers "find something new", the agent route answers "what may I see" and deliberately includes the caller's own pods via its `$or` |

The `members` clause is also subtly unsafe here rather than merely redundant: the route's second `$or` branch keys on **installations** (`agentAuthorizedPodIds`), not membership, so a pod where the agent is a `members` entry *without* an active installation would be excluded by clause 3 and not restored by that branch — disappearing a publicly-listed room from the one reader that just joined it.

**So the shared unit is a fragment, not the builder:** listing flags + `joinPolicy` compose into both surfaces; each adds its own caller clause. One predicate, composed differently at the edges — which is the same lesson as the original `COMMUNITY_LISTING_QUERY`-vs-`communityDiscoverQuery` split, one level down.

**Standing principle either way:** divergence between the human and agent visibility surfaces must be a decision with an affordance attached, never a side effect of which query constant a route imported. **Revisit trigger:** H5 request-access landing — at which point the `joinPolicy` clause is removed from *both* surfaces together, because the row finally acquires a verb.

**Urgency: none, measured.** 3 community-listed pods exist and 0 are invite-only, so the divergence is currently theoretical and a regression test for it would pass vacuously against production data. Fix it when the route is next touched; write the test when an invite-only listed pod exists to test against.

**Rule this generalizes into (ADR-016's operative clause):** *terminal privacy and visibility tiers must be enforced at every read surface, not only at the writers that set them.* A tier enforced at 4 of 5 readers is not a tier.

## Writers, current and planned

| Writer | Sets | Guard | Status |
|---|---|---|---|
| `POST /api/admin/pods/:id/showcase` | tier ↔ private/showcase | admin; refuses dm kinds; unlist cascade | live (PR #766-era + #779 cascade) |
| `POST /api/admin/pods/:id/listing` | tier ↔ showcase/community | admin; 409 below showcase; refuses dm kinds | PR #779 |
| Creation flow presets (#770 deliverable 2) | joinPolicy at creation; tier stays `private` | presets can only express the 7 reachable states | parked until this ADR ratifies |
| Owner "request listing" | asks an admin for tier promotion | H5 request-access shape | phase 2, explicitly out of scope here |

Answering the stub's second question: **visibility is not chosen at creation.** Every pod is born `private`; promotion is a later, deliberate act on a pod that has content worth disclosing. This matches the curation model, keeps the creation modal to one honest choice (join policy), and makes "I accidentally created a public pod" structurally impossible.

## Out of scope

- `parentPod` / pods-as-graph — parked (register P2) pending competitor-source evidence; separate ADR if activated.
- Renaming the storage columns; retiring `type` values.
- The consumer-vs-developer positioning question (unchanged from stub).
- Request-access (H5) mechanics — only its *slot* in the model is reserved (state row 5's Discover exclusion).

## Consequences

- #770's modal can now be designed against a ratified vocabulary: one kind, one join choice at creation, tier promotions elsewhere.
- Every future read surface composes `canViewPod` (read) with `podListing` (find/join); a new endpoint that open-codes a flag is reviewable as a defect by rule 5.
- The showcase F3 warning inherits a sharper statement: promotion to `showcase` is the world-readable event; `community` adds findability and (if open) joinability, never readability.
