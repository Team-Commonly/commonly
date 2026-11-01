# Initiative primitive: design proposal (I-1)

Status: **Accepted** (2026-10-26). It was Proposed and reviewed before ratification. Pin: `ec85e625c` (main). No code in this document; the build follows the rows in section 6.

## Problem

Directions given to agents get handed off and then go quiet. A direction-giver
cannot see which direction is moving without asking each owner. The manual
version works only because someone writes it by hand: an operator-kept ledger of
directions, grouped into initiatives, with a hand-written daily digest. The
status is whatever the writer believes. The product version must produce the
same digest from records that already exist, detect stalls without anyone
declaring them, and add at most one new piece: the nudge.

Reference spec: the hand-written digest and its status rules. A status counts
only dated evidence: a merge, a deploy, a send, a walk or a measurement. A plan,
an assignment or a promise does not count. `done` needs the end state observed,
and a person other than the owner observes it. Section 3 maps the digest
sections onto derived fields.

## 1. Data model

**Recommendation: a new `Initiative` collection, with typed links.**

```
Initiative {
  _id, title, endState (one line),
  direction (user id of the direction-giver),
  owner { userId | agentUserId },        // stored; set by the lead, never by status
  links: [{ kind: 'task' | 'pr' | 'pod' | 'decision', ref, addedAt }],
  cadence { windowHours: 24, digest: 'weekly' },   // one setting per initiative
  closed { at, byUserId, evidenceUrl, note } | null,  // section 2, close-with-evidence
  nudges: [{ episodeStart, nudgedAt }],   // audit trail of sent nudges (section 4)
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
- **ADR-033** (Accepted 2026-10-25, `docs/adr/ADR-033-grant-record.md` on main
  at `97f2ac1d`, after the pin). Section 5 covers it. v1 adds no record kind
  and writes no `seats.record` line.
- **Pod focus** (`backend/models/Pod.ts:112-115`, `podFocusService.ts:9-14`).
  A pod-scoped goal with `nextTaskIds`. One pod only, no derived status. Leave it alone.

## 2. Status derivation

Rule for every row: status is computed from the evidence records below, or from
the close record. No owner-written field sets a status. Each record is cited at the pin.

**Evidence records (the only inputs to moving and stalled):**

- **Merge.** The system update that `completeTaskForMergedPull` pushes onto a
  Task when its linked PR merges: `author: 'system'`, `authorId: null`
  (`services/githubGigService.ts:80-89`, update at :84). Its `createdAt` is the
  evidence date.
- **Resolved decision.** A DecisionRequest with `status: 'ruled'`, dated by
  `ruling.at` (`models/DecisionRequest.ts:25, :84`).

**Close record (the reference's `done`):**

- Only the direction-giver can close an initiative. The close writes
  `closed = {at, byUserId, evidenceUrl, note}`: one evidence URL (a walk, a
  deploy log, a sent message) and a one-line note. The close is a dated record,
  not a status field, and it is a write that ends a record (Tier 2, section 6).
- If the owner is also the giver, the view shows **closed by owner**. That
  close is not an independent observation, so the digest flags it rather than
  counting it as done.

**Not evidence, deliberately excluded:**

- Owner-written Task `updates[]` (`models/Task.ts:7-12, :85-92`, written via
  `tasksApi.ts:809`) and `claimedAt` / lease renewals (`Task.ts:28, :31`). Seats
  renew leases with update notes, so counting these would make a stalled row
  read as moving.
- `POST /complete` (`routes/tasksApi.ts:714, :729`) and PATCH `status` (`:1010`).
  Any pod writer can set `done` there, so it is self-reported.
- A merge alone. A merged PR is not the end state.

**Records v1 cannot see.** A deploy, a send, a walk and a measurement have no
record that the derivation reads. Until a close record exists, an initiative
whose only progress is one of those reads as stalled. The digest says so
rather than hides it.

| Status | Rule | Derived from |
|---|---|---|
| **moving** | At least one link has evidence dated inside the window (default 24 h) | merge record, resolved decision |
| **stalled since \<date\>** | The newest evidence is older than the window. The date is that evidence's date. With no evidence at all, the date is `createdAt`. A stalled part is shown inside a moving initiative with its own date. | same |
| **blocked on X** | A link is a pending DecisionRequest (`models/DecisionRequest.ts:41, :77`). X is its title. | `DecisionRequest.status` |
| **waiting on you** | A pending decision linked to the initiative, with an open AttentionItem of `kind='decision'` and `recipientUserId = initiative.direction` (`models/AttentionItem.ts:3`; per-member fan-out at `services/attentionItemService.ts:452-457`) | `AttentionItem` |
| **needs your check** | Every linked Task is `done` and each has its own merge record; a hand close is never evidence. The initiative has no close record. Shown to the giver under "Needs your check". It is never a stall and never nudges. | merge record, plus Task status |
| **closed** | A close record exists by the giver. **closed by owner** when the owner is the giver. | close record |

**Precedence.** An initiative shows exactly one status: the first rule that matches, in this order.
1. **closed**. A close is terminal and overrides everything else.
2. **waiting on you**. This is the giver-specific case of a pending decision, so it beats *blocked on X*.
3. **blocked on X**. A pending decision outranks evidence. Recent activity next to an open blocker is still blocked.
4. **needs your check**. Finished work outranks recent evidence, because the next step is the giver's.
5. **moving**.
6. **stalled since \<date\>**.

Only the selected status drives the nudge in section 4. A stalled *part* inside a higher-ranked
status is shown as a line, never as a nudge.

**Blocked on the owner's own flag is excluded.** `Task.status = 'blocked'`
(`models/Task.ts:5`) is an owner-written field. v1 shows it as a note on the
link, not as a status. This departs from the reference, where "blocked" can
name the giver's hands or an outside party; those cases come from pending decisions.

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
- **Cadence.** The window and digest cadence are one setting per initiative
  (`cadence`, section 1), defaulting to 24 h for the window and weekly for the digest.

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
| Waiting on you | `waiting on you` rows |
| Needs your check | `needs your check` rows, for the giver only |
| Status, per initiative | The heading leads with the initiative's **motion**: *moving* if any link has evidence in the window, otherwise *stalled since \<date\>*, or *closed* / *needs your check* when those apply. Pending decisions follow, named by their title ("moving, blocked on <title>") or counted ("moving, 3 decisions blocked on you"). A link has no part field, so the digest never names parts. This matches the reference digest. The single selected status from the precedence in section 2 still drives sorting, the waiting-on-you section and the nudge. |
| Stalled part inside a moving initiative | per-link status, with its `stalled since` date shown beside the moving line |
| What moved in the window | merge and resolved-decision records dated inside it |
| Next step, with owner | the open link (Task `pending` or `claimed`) with the lowest `taskNum`, owner `claimedBy \|\| assignee`. If no open task, the pending decision. (`taskNum` at `models/Task.ts:16`.) |

## 4. Stall and nudge

- **Detection.** An initiative is stalled when its status is `stalled since`
  (section 2). `needs your check` is never a stall and never nudges.
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
- **Nudge pod.** `AttentionItem.podId` is required, and an initiative spans pods. The pod is the
  one of the owner's open linked Task with the lowest `taskNum`, the same rule as *Next step* in
  section 3. Failing that, it is the first `pod` link. Failing both, nothing is sent and the digest
  shows "no pod to route". The installer lookup runs in that pod. Each fallback has a test in row 3.
- **The one new piece.** `AttentionSourceType` is a closed union
  (`models/AttentionItem.ts:4`: `message | approval | decision_request | task`).
  Adding `'initiative'` is the single schema change. The `source.type` enum in
  the schema (`:55`) gets the same value.
- **Dedupe for the agent path.** The installer path also writes an AttentionItem,
  so the same unique index covers it. `nudges` on the Initiative is an audit
  trail only.
- **Not used.** ADR-017 (`ADR-017-attention-routing.md:3`, Proposed) has a
  blocker concept at :81–94. It is unratified and is not relied on. ADR-018
  (Accepted) governs any path that wakes an agent, and v1 does not take one.

## 5. Out of v1, and the ADR-033 path

- Initiative creation UI. v1 creates rows through the API or a script.
- Counting unlinked merged PRs as progress (needs a PR-to-task sync that does not exist).
- Cross-workspace or federated initiatives.
- Per-pod digests (new code, see section 3).
- Manual status overrides. The close record is the only human write that changes the view.

**v2 evidence path (ADR-033).** ADR-033 (Accepted) defines the record for agent
runs: `result.reported` with `refs: [{type, id}]` (`docs/adr/ADR-033-grant-record.md:213`),
`tool.call` with `surface: commonly` (:210), `task.done`, written by the board (:201),
and `decision.ruled` (:206). The board owns claims (D4, :84).
Those lines can carry evidence for work an agent performed. They have no kind
for a human deploy, a send or a walk. So v2 can count an agent's sent message
or walk through `result.reported`, and a human deploy still needs either a new
kind or the close record. The ADR's own gaps apply: `commonly_*` calls are not
recorded server-side until TASK-513 ships.

**v1 conflicts with ADR-033: none.** v1 writes no `seats.record` line. Its close
record lives in the `Initiative` collection, not in the record format. It reads
merge and decision records and does not treat a `task.done` line as evidence.
It does not move the board (ADR-033 D4), and it adds no field to the record
format. A v2 reader of `result.reported` can be added later without changing v1.

## 6. Effort for an 11-02 v1

Initiatives plus a weekly digest. Each item names its witness and tier.
Tiers: **general** for ordinary work, **opus** for kernel, record or auth,
**Tier 2** for writes that end a record or touch the attention path (two
gates, one non-Haiku), and **review** for a non-author gate.

| # | Item | Witness | Tier |
|---|---|---|---|
| 1 | `Initiative` model and link validation | Unit: rejects unknown link kinds; `cadence` defaults to 24 h and weekly | general |
| 2 | Status derivation over merge and resolved-decision records only | Unit table, one case per status row, including a Task `updates[]` write that must NOT change status, a merge that must read `needs your check` and not stall, and one case per precedence overlap (pending decision + recent evidence → blocked; a close + recent evidence → closed; all merged + recent evidence → needs your check) | opus, Tier 2 |
| 3 | Stall detection; AttentionItem nudge for human owners and the installer; `'initiative'` source type | Service test: two stalls in one episode produce one row; agent owner with no installer produces none; `needs your check` produces no nudge | opus, Tier 2 |
| 4 | Weekly digest generator and email, behind `digest.sending` | Dry run against a seeded initiative | haiku |
| 5 | Activity quiet card (new section) | Presence test plus a 390 and 1440 browser walk against ux-lead's artboard (due 10-28) | Tier 1 |
| 6 | Reproduce the reference digest from a seeded fixture | Diff of section titles, ordering and status lines | review |
| 7 | Close-with-evidence: giver-only write of the close record, and the "closed by owner" label | Unit: a non-giver close is refused; owner-as-giver shows "closed by owner" | general, Tier 2 |

## Open items

- **ADR-033 read.** Its record kinds are in section 5. The v2 evidence path
  needs a decision on human deploy, send and walk records. That is a v2 question.
- **Reference digest gate.** Step 6 is still open. The generator is not written,
  so nothing has been diffed against a generated output yet.
- **Deploy, send and walk have no record in v1.** This is a known gap, not a fix.
  The digest will show such initiatives as stalled until a close record exists.
