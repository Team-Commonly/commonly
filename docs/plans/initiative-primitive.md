# Initiative primitive: design proposal (I-1)

Status: proposal, for CTO review. Pin: `ec85e625c` (main). No code.

## Problem

Sam's directions get handed to many agents and then go quiet. A lead cannot see
which direction is moving without asking each owner. The manual version we run
today (a ledger of Sam's directions grouped into initiatives, plus a daily
digest) works only because someone writes it by hand, so the status is whatever
the writer believes. The product version must produce the same digest from
records that already exist, detect stalls without anyone declaring them, and
add at most one new piece: the nudge.

Reference spec: the manual digest. Its rules are at the top of the initiatives
index (`initiatives-1025.md`, the status table). A status counts only dated
evidence: a merge, a deploy, a send, a walk or a measurement. A plan, an
assignment or a promise does not count. `done` needs the end state observed.
Section 3 maps the digest sections onto derived fields.

## 1. Data model

**Recommendation: a new `Initiative` collection, with typed links.**

```
Initiative {
  _id, title, endState (one line),
  direction (user id of whoever gave the direction),
  owner { userId | agentUserId },        // stored; set by the lead, never by status
  links: [{ kind: 'task' | 'pr' | 'pod' | 'decision', ref, addedAt }],
  nudges: [{ episodeStart, nudgedAt }],   // dedupe for agent owners (section 4)
  createdAt, archivedAt
}
```

Why not fields on Task:

- An initiative spans pods (Task.podId is single-valued, `models/Task.ts:15`) and PRs.
  A field on Task can name one initiative per task and cannot express a pod or
  a decision.
- Identity has to survive its tasks closing. Tasks reach `done` and stay
  (`models/Task.ts:5`), so an initiative stored on them would vanish from the
  view the moment its last task closes. A standalone row does not.

Prior art, and what it reserves:

- **ADR-028** (Draft, `docs/adr/ADR-028-work-claims-and-decision-ledger.md:3`).
  D1 (:222) gives a claim a work area; D4 (:259) records disposition; D5 (:294)
  types decisions with explicit supersede; D10 (:443) makes a digest a read over
  the ledger. This proposal adds no claim or disposition fields. Decision links
  point at the ledger rows. If ADR-028 ratifies, `owner` should reference its
  claim record. ADR-028 is unratified, so nothing here depends on it.
- **Pod focus** (`backend/models/Pod.ts:112-115`, `podFocusService.ts:9-14`).
  A pod-scoped goal with `nextTaskIds`. One pod only, no derived status. Leave it alone.

## 2. Status derivation

Rule for every row: status is computed from the evidence records below. No
owner-written field sets a status. Each record is cited at the pin.

**Evidence records (the only inputs):**

- **Merge.** The system update that `completeTaskForMergedPull` pushes onto a
  Task when its linked PR merges: `author: 'system'`, `authorId: null`
  (`services/githubGigService.ts:80-89`, update at :84). Its `createdAt` is the
  evidence date.
- **Resolved decision.** A DecisionRequest with `status: 'ruled'`, dated by
  `ruling.at` (`models/DecisionRequest.ts:25, :84`).

**Not evidence, deliberately excluded:**

- Owner-written Task `updates[]` (`models/Task.ts:7-12, :85-92`, written via
  `tasksApi.ts:809`) and `claimedAt` / lease renewals (`Task.ts:28, :31`). Seats
  renew leases with update notes, so counting these would make a stalled row
  read as moving.
- `POST /complete` (`routes/tasksApi.ts:714, :729`) and PATCH `status` (`:1010`).
  Any pod writer can set `done` there, so it is self-reported.

**Records v1 cannot see.** A deploy, a send, a walk and a measurement have no
record at the pin. v1 counts none of them, so an initiative whose only progress
is a deploy will read as stalled. The digest must say so rather than hide it.

| Status | Rule | Derived from |
|---|---|---|
| **moving** | At least one link has evidence dated inside the window (default 24 h, a setting) | merge record, resolved decision |
| **stalled since \<date\>** | The newest evidence is older than the window. The date is that evidence's date. If an initiative has no evidence at all, the date is its `createdAt`. | same |
| **blocked on X** | A link is a pending DecisionRequest (`models/DecisionRequest.ts:41, :77`). X is its title. | `DecisionRequest.status` |
| **waiting on you** | A pending decision for which an open AttentionItem of `kind='decision'` exists with `recipientUserId = Sam` (`models/AttentionItem.ts:3`; written per human member at `services/attentionItemService.ts:452-457`) | `AttentionItem` |
| **merged, end state unverified** | Every linked Task is `done` and a linked PR has a merge record | merge record, plus Task status |

**Not derived in v1: `done`.** The reference's `done` needs the end state
observed (live, walked, sent). No record of that exists at the pin, so v1
cannot produce it. An initiative whose tasks all merged shows
`merged, end state unverified` until a person closes it with an evidence link,
and even that link is out of v1 (section 5).

**Blocked on the owner's own flag is excluded.** `Task.status = 'blocked'`
(`models/Task.ts:5`) is an owner-written field. v1 shows it as a note on the
link, not as a status. This departs from the reference, where "blocked" can
name Sam's hands or an outside party; those cases come from pending decisions.

**Other findings that shape the rules:**

- **Activity cannot carry progress.** `models/Activity.ts` has no task or GitHub
  type. Its writers are chat, thread, follow, install and auto-join paths
  (`activityService.ts:1354–1427` is seed data only; `postController.ts:361,527`;
  `routes/agentsRuntime.ts:3897`; `routes/registry/install.ts:890`). No task
  write reaches it.
- **`prUrl` has no sync writer.** It is written only by `/complete` and PATCH
  (`tasksApi.ts:729, :1014, :1070`); the webhook reads it as a match key. A PR
  that no task names is invisible to this model. v1 reports the count of unlinked
  merged PRs instead.
- **Owner per link is `claimedBy || assignee`** (`models/Task.ts:22, :27`).
- **No pending-decision query by user exists.** Per-user reads go through
  AttentionItem (`attentionItemService.ts:676`, filtered by `recipientUserId`, `:755-759`).

## 3. Digest: generation and delivery

Reuse what exists:

- **Generation pattern.** `services/dailyDigestService.ts` builds one summary per
  user from `ActivityService.getRecap` (`:171`). The hourly cron is
  `services/schedulerService.ts:211` (`'1 * * * *'`), which sends through
  `digestEmailService.ts:142-300`. Kill switch: the `digest.sending` setting
  (`digestEmailService.ts:28-45`).
- **Do not cite `docs/ai-features/DAILY_DIGESTS.md`.** It describes an older
  LLM-narrated newsletter at 06:00 UTC, which the code no longer does.
  `docs/runbooks/daily-digest.md` is the current operational view.
- **Scope.** The existing digest is per user (`dailyDigestService.ts:171`), with
  no pod parameter. The initiative digest is a new generator that reads
  `Initiative` rows, groups them by `direction`, and reuses delivery and the kill switch.

Delivery:

- **Email** through `digestEmailService`, as today.
- **One quiet card** in Activity (`frontend/src/v2/components/V2ActivityPage.tsx`,
  route `V2App.tsx:313-314`). Needs-you (`:1242`) and moved-forward (`:1467`)
  are the existing sections. `NeedsYouItem.kind` is a closed union (`:49`), so
  the card needs a new section, not a reuse of that kind. Chat's `kind:'card'`
  (`frontend/src/v2/utils/threadView.ts:14-22`) is a thread item, not a feed item.

Mapping, reference digest section to derived field:

| Digest section | Derived field |
|---|---|
| Waiting on Sam | `waiting on you` rows |
| Status, per initiative | the status column in section 2 |
| Stalled part inside a moving initiative | per-link status, with its `stalled since` date shown beside the moving line |
| What moved in 24 h | merge and resolved-decision records dated in the last 24 h |
| Next step, with owner | the open link (Task `pending` or `claimed`) with the lowest `taskNum`, owner `claimedBy \|\| assignee`. If no open task, the pending decision. (`taskNum` at `models/Task.ts:16`.) |

## 4. Stall and nudge

- **Detection.** An initiative is stalled when its status is `stalled since`
  (section 2). The window is the same 24 h setting.
- **Episode.** `episodeStart` is the timestamp of the newest evidence record
  when the stall began. A stall with no evidence at all uses the initiative's
  `createdAt`. Using evidence time, not run time, keeps each run from minting a
  new id.
- **One nudge per episode, routed by owner type:**
  - **Human owner.** An AttentionItem with `kind: 'blocked'`, `source.type:
    'initiative'`, `source.id: initiative:<id>:stall:<episodeStart ISO>`. The
    unique index `{recipientUserId, source.type, source.id}` (`models/AttentionItem.ts:74`)
    dedupes it. Writers already upsert with `$setOnInsert` (`attentionItemService.ts:78-98`).
  - **Agent owner.** AttentionItems go only to human pod members, filtered
    `isBot: {$ne: true}` (`attentionItemService.ts:43-44`). The nudge goes to
    the agent's installer, resolved by the existing `installerForAgent`
    (`attentionItemService.ts:49-64`), as the same kind of AttentionItem. The
    agent is not woken, so ADR-018's wake policy is untouched. If there is no
    installer, the digest lists the stall with "no human to nudge" and nothing is sent.
- **The one new piece.** `AttentionSourceType` is a closed union
  (`models/AttentionItem.ts:4`: `message | approval | decision_request | task`).
  Adding `'initiative'` is the single schema change. The `source.type` enum in
  the schema (`:55`) gets the same value.
- **Dedupe for the agent path.** The installer path also writes an AttentionItem,
  so the same unique index covers it. `nudges` on the Initiative is not needed
  for dedupe and is kept only as an audit trail of which episode was sent.
- **Not used.** ADR-017 (`ADR-017-attention-routing.md:3`, Proposed) has a
  blocker concept at :81–94. It is unratified and is not relied on. ADR-018
  (Accepted) governs any path that wakes an agent, and v1 does not take one.

## 5. Out of v1

- Initiative creation UI. v1 creates rows through the API or a script.
- A `done` status and any evidence record for deploy, send, walk or measurement.
- Counting unlinked merged PRs as progress (needs a PR-to-task sync that does not exist).
- Cross-workspace or federated initiatives.
- Per-pod digests (new code, see section 3).
- Manual status overrides.
- A daily cadence for the card. Weekly is v1; daily is a setting if it is free.

## 6. Effort for an 11-02 v1

Initiatives plus a weekly digest. Each item names its witness and tier.
Tiers: **haiku** for mechanical work, **opus** for kernel, record or auth, and
**review** for a non-author gate.

| # | Item | Witness | Tier | Depends on ADR-033 |
|---|---|---|---|---|
| 1 | `Initiative` model and link validation | Unit: rejects unknown link kinds | opus | no |
| 2 | Status derivation over merge and resolved-decision records only | Unit table, one case per status row, including a Task `updates[]` write that must NOT change status | opus | no |
| 3 | Stall detection; AttentionItem nudge for human owners and installer; `'initiative'` source type | Service test: two stalls in one episode produce one row; agent owner with no installer produces none | opus | no |
| 4 | Weekly digest generator and email, behind `digest.sending` | Dry run against a seeded initiative | haiku | no |
| 5 | Activity quiet card (new section) | Presence test plus browser check (v2 layout rule) | haiku | no |
| 6 | Reproduce the reference digest from a seeded fixture | Diff of section titles, ordering and status lines | review | no |

None of the items depends on ADR-033 at the pin. Items 3 and 5 touch the
attention path and need the review tier.

## Open items

- **ADR-033 not read.** It is absent at the pin. It merged as Accepted on main
  (`97f2ac1d`, #2691) after this pin. It is not cited above. Check it before v1
  relies on any grant or record field.
- **Reference digest gate.** Step 6 is still open, because the generator is not
  written. The rules above are taken from the reference index and the 10-25
  digest on this seat, and nothing has been diffed against a generated output yet.
- **Deploy, send and walk have no record.** This is a known gap of v1, not a fix.
  The digest will show initiatives as stalled when their only progress is one of
  those.
