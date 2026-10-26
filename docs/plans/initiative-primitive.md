# Initiative primitive: design proposal (I-1)

Status: proposal, for CTO review. Pin: `ec85e625c` (main). No code.

## Problem

Sam's directions get handed to many agents and then go quiet. A lead cannot see
which direction is moving without asking each owner. The manual version we run
today (a ledger of Sam's directions grouped into initiatives, plus a daily
digest) works only because someone writes it by hand, so the status is whatever
the writer believes. The product version must produce the same digest from
records that already exist, detect stalls without anyone declaring them, and
add at most one new surface: the nudge.

Reference spec: the daily digest the manual process produces. Its sections are
waiting-on-Sam first, status from evidence, what moved in the last 24h, and the
next step with its owner. Section 2 maps each one onto a derived field.

## 1. Data model

**Recommendation: a new `Initiative` collection, with typed links.**

```
Initiative {
  _id, title, endState (one line), direction (ref to who gave it, a user id),
  owner { userId | agentUserId },           // who is answerable for it
  links: [{ kind: 'task' | 'pr' | 'pod' | 'decision' | 'evidence', ref, addedAt }],
  createdAt, archivedAt
}
```

Why not fields on Task:

- An initiative spans pods (Task.podId is single-valued, `models/Task.ts:15`) and PRs.
  A field on Task can name one initiative per task and cannot express a pod or
  a decision.
- Identity has to survive its tasks closing. Tasks reach `done` and stay
  (Task.ts:5), so an initiative stored on them would vanish from the view the
  moment its last task closes. A standalone row does not.

Prior art, and what it reserves:

- **ADR-028** (Draft, `docs/adr/ADR-028-work-claims-and-decision-ledger.md:3`).
  D1 (:222) gives a claim a work area; D4 (:259) records disposition; D5 (:294)
  types decisions with explicit supersede; D10 (:443) makes a digest a read over
  the ledger. An initiative with an owner and derived status overlaps claim
  custody and the decision ledger. This proposal does not add claim or
  disposition fields. `links.kind = 'decision'` points at the ledger rows, and
  if ADR-028 ratifies, `owner` should become a reference to its claim record.
  ADR-028 is unratified, so nothing here depends on it.
- **Pod focus** (`backend/models/Pod.ts:112-115`, `podFocusService.ts:9-14`).
  A pod-scoped goal with `nextTaskIds`. It is one pod only and has no derived
  status. Leave it alone.

## 2. Status derivation

Rule for every row: status is computed from the linked records listed below. No
owner-written field can set a status. Each record is cited at the pin.

| Status | Rule | Records and fields (file:line at `ec85e625c`) |
|---|---|---|
| **moving** | At least one linked record has a timestamp within N days (default 3) | Task `updates[].createdAt` (`models/Task.ts:7-12, :85-92`), written by `POST /:podId/:taskId/updates` (`routes/tasksApi.ts:809`), `PATCH` (`:1010`), and `POST /complete` (`:714`). Task `claimedAt` (`:28`). PR merge via webhook (`services/githubGigService.ts:80-89`). |
| **stalled N days** | No linked record is inside the window | Same records as above. A stall is the absence of a timestamp, so it cannot be self-reported. |
| **blocked on X** | A linked Task has `status='blocked'` (`Task.ts:5`), or a linked DecisionRequest is `status='pending'` (`models/DecisionRequest.ts:41, :77`). X is the task title or the decision title. | `Task.status`; `DecisionRequest.status`. |
| **waiting on you** | A linked DecisionRequest is pending and Sam is a human member of its pod. Read the open AttentionItem rows, `kind='decision'`, `recipientUserId = Sam` (`models/AttentionItem.ts:3`, written per human member by `services/attentionItemService.ts:452-457`). | `AttentionItem.recipientUserId`, `kind`, `status='open'`. |
| **done with proof** | Every linked Task is `done` AND at least one linked `pr` merged. The done state must come from the merge webhook, not from `/complete`. | `githubGigService.ts:80-89` sets `done` on a merged PR whose `prUrl` matches. `/complete` (`tasksApi.ts:729`) accepts any pod writer and any `prUrl`, so it is self-reported and cannot count as proof. |

Findings that shape these rules:

- **Activity cannot carry task progress.** `models/Activity.ts` has no task or
  GitHub type. Its writers are chat, thread, follow, install and auto-join
  paths (`activityService.ts:1354–1427` is seed data only; `postController.ts:361,527`;
  `routes/agentsRuntime.ts:3897`; `routes/registry/install.ts:890`). No task write
  reaches Activity. Derive from Task and PR records, not from Activity.
- **`prUrl` has no sync writer.** It is written only by `/complete` and PATCH
  (`tasksApi.ts:729, :1014, :1070`), and the webhook reads it as a match key. A
  PR that no task names is invisible to this model. v1 accepts that and reports
  it as a count of unlinked merged PRs.
- **Ownership is `assignee` or `claimedBy`.** There is no `owner` concept in the
  Task model (`Task.ts:22, :27`).
- **No pending-decision query by user exists.** Per-user pending reads go
  through AttentionItem, not DecisionRequest (`attentionItemService.ts:676`
  filters by `recipientUserId`, `:755-759`).

## 3. Digest: generation and delivery

Reuse what exists:

- **Generation pattern.** `services/dailyDigestService.ts` builds one summary per
  user from `ActivityService.getRecap` (`:171`). Its schedule is an hourly cron
  (`services/schedulerService.ts:211`, `'1 * * * *'`), and it sends through
  `digestEmailService.ts:142-300`. The kill switch is the `digest.sending` setting
  (`digestEmailService.ts:28-45`).
- **Do not use `docs/ai-features/DAILY_DIGESTS.md` as a reference.** It describes
  an older LLM-narrated newsletter at 06:00 UTC, which the code no longer does.
  `docs/runbooks/daily-digest.md` is the current operational view.
- **Scope.** The existing digest is per user only (`dailyDigestService.ts:171`),
  with no pod parameter. The initiative digest is a new generator that reads
  `Initiative` rows and groups them by `direction`. It reuses delivery and the
  kill switch.

Delivery:

- **Email** through `digestEmailService`, as today.
- **One quiet card** in Activity (`frontend/src/v2/components/V2ActivityPage.tsx`,
  route `V2App.tsx:313-314`). The page has a needs-you section (`:1242`) and a
  moved-forward section (`:1467`). `NeedsYouItem.kind` is a closed union
  (`:49`), so a digest card needs a new section or kind, not a reuse. Chat's
  `kind:'card'` (`frontend/src/v2/utils/threadView.ts:14-22`) is a thread item,
  not a feed item.

Mapping, Cofounder digest section to derived field:

| Digest section | Derived field |
|---|---|
| Waiting on Sam | `waiting on you` rows |
| Status from evidence | the status column above |
| What moved in 24h | links with a timestamp in the last 24h |
| Next step, with owner | the open task with the earliest `assignee`, or the pending decision |

## 4. Stall and nudge

- **Detection.** An initiative is stalled when no `moving` record is inside the
  window (default 3 days). The window is a setting.
- **One nudge per stall episode.** Dedupe on
  `AttentionItem` unique index `{recipientUserId, source.type, source.id}`
  (`models/AttentionItem.ts:74`). Set `source.id` to
  `initiative:<id>:stall:<episodeStartIso>`. A second stall in the same episode
  then cannot insert a second row. Writers already upsert with `$setOnInsert`
  (`attentionItemService.ts:78-98`), so no new dedupe code is needed.
- **Path.** The nudge is an AttentionItem row. The existing kinds are
  `mention|approval|decision|handoff|blocked` (`AttentionItem.ts:3`). No `stall`
  kind exists, and this proposal adds none. Use `blocked` for an owner who must
  act and `handoff` for a reassignment. The nudge wakes no new runtime.
- **Wake policy.** For an agent owner, delivery goes through the existing
  attention path, which ADR-018 governs (`ADR-018-agent-attention-claims.md:3`,
  Accepted, with its wake-on-message rule at :399). I did not read the full
  delivery code for an agent-owned AttentionItem. Keel should confirm that
  delivery before this ships.
- **If nothing fits.** ADR-017 (`ADR-017-attention-routing.md:3`, Proposed) has a
  blocker concept at :81–94 that overlaps this, but it is unratified and must
  not be relied on. v1 uses the AttentionItem row above and records the ADR-017
  dependency as open.

## 5. Out of v1

- Initiative creation UI. v1 creates rows through the API or a script.
- Cross-workspace or federated initiatives.
- Per-pod digests (needs new code, see section 3).
- Counting unlinked merged PRs as activity (needs a PR-to-task sync that does not exist).
- A status that anyone can set by hand. Manual overrides are out.
- A daily cadence for the card. Weekly is v1; daily is a setting if it is free.

## 6. Effort for an 11-02 v1

Initiatives plus a weekly digest. Each item names its witness and tier.
Tiers: **haiku** for mechanical work, **opus** for kernel, record or auth, and
**review** for a non-author gate.

| # | Item | Witness | Tier | Depends on ADR-033 |
|---|---|---|---|---|
| 1 | `Initiative` model and link-validation | Unit: rejects unknown link kinds | opus | no |
| 2 | Status derivation (pure function over the records above) | Unit table, one case per status row | opus | no |
| 3 | Stall detection and AttentionItem nudge with dedupe | Service test: two stalls in one episode produce one row | opus | no |
| 4 | Weekly digest generator and email, behind `digest.sending` | Dry run against a seeded initiative | haiku | no |
| 5 | Activity quiet card (new section) | Presence test plus browser check (v2 layout rule) | haiku | no |
| 6 | Reproduce the manual digest from a seeded fixture | Diff of section titles and ordering | review | no |

Mark anything that depends on ADR-033 being ratified. Today none of the items
depends on it, because ADR-033 is cited only in the grant-record context. Items
3 and 5 both touch ADR-018 wake policy and need the review tier at that point.

## Open items

- **Reference digest not on disk.** The manual files named in the brief
  (`initiatives-1025.md`, `initiatives-digest-<date>.md`) are not in the notes
  directory on this seat, so step 6 cannot be checked against them yet. The
  section mapping above is taken from the brief's description, not the file.
- **ADR-033 not read.** It is absent at the pin. It merged as Accepted on main
  (`97f2ac1d`, #2691) after this pin. It is not cited above and should be
  checked before v1 relies on any grant or record field.
- **Status names for ux-lead** are in the next message to keel.
