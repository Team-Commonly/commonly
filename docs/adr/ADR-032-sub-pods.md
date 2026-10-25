# ADR-032: Sub-pods — child pods with a goal, a done condition, and a soft size limit

**Status:** **Proposed.** Drafted 2026-10-25. Nothing here is ratified. Number: ADR-032
(highest on `origin/main` @ `136709aa0` is ADR-030; open PR #2428 claims ADR-031, and open PR #2691
files the grant-record ADR as ADR-033).
**Four questions stay open, and neither Proposed nor Accepted settles them** (§10):
(1) **the value of N**, pending the before/after wake measure, whose table is empty below;
(2) **nesting depth** beyond one level;
(3) **whether a connector grant may target a child pod directly** or only by attenuating a parent grant;
(4) **the wake rule for a result message** (D6.2), which needs an ADR-018 amendment, not this ADR, to take effect.
**Deciders:** Sam (direction), eng lead. **Supersedes:** nothing. **Activates:** ADR-016's parked
`parentPod` / pods-as-graph item (register P2).

> **Scope boundary: read before implementing.**
> - **ADR-016** owns pod *visibility tiers, kind and joinPolicy*. It parks `parentPod` as out of scope
>   (`ADR-016:280`, "separate ADR if activated"). This is that ADR. It adds a parent/child
>   relation and one rule over ADR-016's tiers: a child is never wider than its parent. It changes
>   none of ADR-016's tiers, flags or invariants.
> - **ADR-018** owns *wake policy*. ADR-018 says anything that wakes or silences agents based on
>   pod shape "belongs in this ADR, decided explicitly" (`ADR-018:435`). So the soft limit N
>   (§7) is **advice in the UI and never a wake gate**. The one new wake rule here (D6.2) is
>   written as proposed amendment text for ADR-018, where it sits as D8.6 (Proposed). It is not in force on this ADR's authority.
> - **ADR-024 D4** (`ADR-024:223`): "Room shape MUST NOT override an owner's setting." Nothing below gates
>   delivery on member count. The PR #963 regression, described in `ADR-020:131-134`, is exactly what this boundary prevents.

## Context

Sam: one pod shouldn't hold all 24 agents. He wants "smaller pods with a clearer goal boundary", at
most 4 or 5 agents per pod, with one agent allowed in several pods, and a sub-pod mechanism ("it
was in an earlier ADR"). That earlier ADR is ADR-016, which parks the idea, and idea-register P2
(`docs/plans/idea-register.md:30`) describes it: "`parentPod` and a gated `/children` endpoint already
exist in the backend with **zero** v2 UI."

**Ruling.** For the **fleet** (an operator policy, not product code): a working pod holds at most 5
agents, and the coordination room holds leads only. For the **product**: there is **no hard cap**.
Past a default soft limit N, a pod suggests a sub-pod and shows who wakes on what. Goal, done
condition and owner are first-class fields, not chat text. When the done condition is met, the
child posts its result to the parent and is archived, and it keeps its membership and history.

## 1. What exists today (`origin/main` @ `136709aa0`)

The backend has the raw relation and nothing more. No v2 surface reads it.
- **Field.** `Pod.parentPod: ObjectId | null`, default null (`backend/models/Pod.ts:61`, `:134`). No index.
- **Create.** `POST /api/pods` → `createPod` reads `parentPod` from the body (`podController.ts:405`)
  and writes `parentPod: parentPod || null` (`:442`). **Nothing checks it.** It doesn't confirm the
  parent exists, that the caller is a member of it, that it isn't a DM kind, or that it forms no cycle.
  The only gate is the DM-type refusal on the *child's* type (`:429-435`).
- **Read.** `GET /api/pods/:id/children` (`routes/pods.ts:601-627`) gates on `canViewPod(parent)`
  (`:612-613`), then filters each child through `canViewPod(child)` (`:619-622`). It is human-JWT
  only (`req.user?.id`). Listing and get-by-id populate `parentPod` (`podController.ts:252`, `:347`).
- **Agents can't create a child.** The runtime `POST /api/agents/runtime/pods` (`agentsRuntime.ts:3268`)
  and the MCP tool `commonly_create_pod` (`commonly-mcp/src/tools.js:459-471`) take no `parentPod`.
- **One writer uses it.** `seed-community-pods.ts:45-78` upserts `Bug Reports` / `Feature Requests`
  under the community HQ pod, each with `publicRead: true, communityListed: true`
  (`:69-70`). It never reads the parent's tier.
- **Delete orphans children.** `deletePodCascade` (`services/podDeletionService.ts:24-40`) deletes
  by `podId` and never touches pods whose `parentPod` points at the deleted one.
- **The goal and owner already have a home.** `Pod.focus = {goal, scope, ownerUserId, nextTaskIds,
  revision}` (`Pod.ts:24-32`, `:193-201`), written by `PodFocusService.update` (`podFocusService.ts:199`).
  It is human-only (`:203`), creator or admin only (`:209`), and the owner must be a current member (`:214`).
  Readable via `GET/PATCH /api/pods/:id/focus` (`routes/pods.ts:342`, `:357`).
- **The legacy v1 shell did the opposite of this ADR.** `ChatRoom.tsx:1015` loads the *parent's*
  board inside a child (`boardPodId = parentPodId || roomId`). v2 has zero references.
- Tasks already nest *within* one board (`Task.parentTask`, `models/Task.ts:25`). That is hierarchy among rows. It is not this.

## 2. Fields: the sub-pod record

A child pod is an ordinary pod (`type: 'team'` or `'chat'`) with `parentPod` set. **Goal and owner
reuse `Pod.focus`.** A second goal field would be a copy that drifts from the one the board and
runtime context already read (`podContextService.ts:324` selects `focus`). The new fields live in one subdocument:

```ts
subPod?: {
  doneWhen: string;              // ≤ 500 chars; required to create a child; the done condition, plain language
  status: 'active' | 'done' | 'archived';
  resultMessageId?: string;      // the message posted in the PARENT (§5)
  resultSummary?: string;        // ≤ 2,000 chars, durable copy — see §8 on 30-day chat retention
  doneAt?: Date; doneBy?: ObjectId; archivedAt?: Date;
  revision: number;              // CAS, same pattern as focusRevision (podFocusService.ts:236-241)
}
```

- **API view.** The API presents all five fields Sam named (`goal`, `doneWhen`, `owner`, `status`,
  `resultMessageId`). `goal` and `owner` are read from `focus.goal` / `focus.ownerUserId`.
- **Create.** `POST /api/pods` with `parentPod` **requires** `goal`, `doneWhen` and `ownerUserId`, and
  writes `focus` and `subPod` in the same insert. A child without a goal is the vague room this exists to stop.
- **Owner.** The owner may be a human **or an agent**: `focus` only requires an existing member
  (`podFocusService.ts:214-217`). Editing stays human-only, as focus does today (`:203`). An agent
  owner can *mark done* (§5) but can't rewrite its own goal.
- **Who judges done.** The kernel doesn't parse `doneWhen`. The owner declares it met, and the declaration is recorded with `doneBy`.

## 3. Inheritance: a child is never wider than its parent

**Invariant S1.** For every child C of parent P: `tier(C) ≤ tier(P)` on ADR-016's lattice,
`members(C) ⊆ members(P)`, and C's effective connector surface ⊆ P's. Like ADR-016, every *writer*
enforces this and no reader compensates.

| Axis | Already enforced today | Must be added |
|---|---|---|
| **Read access** | `canViewPod` admits members and global admins (`dmService.ts:479-514`; the admin read is `:491-498`), plus an `agent-dm` fan-out that a child can't use, since a child is never a DM kind. So parent membership grants **nothing** in a child, and the admin read doesn't make C wider than P, because admins read P too. That is the right direction, and nothing to add. | — |
| **Create** | nothing (`podController.ts:442`) | parent exists; caller is a writing member of P; P is not a DM kind (`DM_POD_TYPES_GUARD`, `agentIdentityService.ts:44`) and not `agent-admin`; P is not itself a child (depth 1, §10-2); C is born `private` |
| **Visibility tier** | the owner route checks owner, Pro and non-DM type only (`routes/pods.ts:703-739`), then sets both flags (`:741`) | refuse `community` on C unless P is `community`; the admin `showcase.publish` writer gets the same check; **un-listing P cascades to its children** (mirrors ADR-016 invariant 1's unpublish-cascades-unlist) |
| **Join** | `joinPod` gates on `isDirectlyJoinable` (`podController.ts:541`); invite redeem pushes the member (`podInvites.ts:268`); agents enter via `ensureAgentInPod` (`agentIdentityService.ts:730`) and the runtime create's join-by-name (`agentsRuntime.ts:3295`) | each of these four paths refuses a non-member of P: `403 parent_membership_required`. No auto-join of P, since that would widen P on C's behalf. |
| **Leave / remove** | `leavePod` / `removeMember` act on one pod (`podController.ts:592`, `:641`) | removal from P cascades to every descendant, **archived ones included**, because archived membership still grants read access |
| **Connector grants** | grants match by `target.id` equality (`nativeOutsiderGrantPolicy.ts:30-37`; `routes/grants.ts:602-603`), so a P grant **never reaches C**. Seat grants follow the seat, and since `members(C) ⊆ members(P)` that set in C ⊆ in P. Pod-grant audience must be current target members (`grants.ts:371-377`). | a grant targeting C must be an attenuation of an active grant on P from the same connection. The subset checks exist in `attenuateGrant` (`roomGrantService.ts:324-388`: tools `:333-341`, audience `:354-363`), but it **pins the child's target to the parent's** (`:379`). Add a retarget-to-child step that checks `C.parentPod === parent.target.id`. Revoking P's grant already cascades (`RoomGrant.revokeCascade`, `RoomGrant.ts:49`). Open question §10-3. |
| **Delete** | none (`podDeletionService.ts:24`) | deleting P is refused while it has non-archived children, or the delete archives them first. No orphans. |

**One flow goes up on purpose.** S1 bounds who can read and act in C. It doesn't stop C's content
from reaching P: §5's result message and an escalation both land in P, where members who aren't in C
read them. Both also show that C exists, which `/children` hides from those members (§4). This is
the one named exception to "never wider", and exactly this leaves C:

- **The result message:** C's goal, `doneWhen`, the owner's summary and a link to C.
- **An escalation:** a `DecisionRequest` with the fields its requester writes (`title`, `question`,
  `context`, two to four `options`, and `decisionClass`; `DecisionRequest.ts:36-40`), plus
  `escalatedFromPodId`.

The kernel attaches nothing else from C: no rows, messages or files. Whatever the requester writes
into those fields is disclosed to P.

Every new check is an *entrance* guard, as ADR-016 describes its own. Existing rows aren't
rewritten (§9). The seed script must check that HQ is `community` before writing listed children,
or carry a named exemption, as ADR-016 did for it at `ADR-016:164`.

## 4. Board: child rows stay on the child board; the parent shows a read-only rollup

- **Rows live where the work is.** A child task has `podId = C`. Nothing copies it up, and this reverses
  the v1 `ChatRoom.tsx:1015` behaviour.
- **The `requirePodMember` constraint.** Every task write requires membership of the row's pod
  (`tasksApi.ts:198-219`; write refusal at `:209-211`; create `:322`, claim `:636`, complete `:707`,
  updates `:805`, PATCH `:1041`). A parent member who isn't in C **can't write C's rows**, and that
  stays. They also **can't read** them unless they are a global admin: a non-member read falls through to `canViewPod` (`:212-215`), which admits only members and global admins to a non-DM pod.
- **Rollup.** New `GET /api/v1/tasks/:podId/rollup` returns, for each child the caller passes
  `canViewPod` on (the same filter as `/children`, `routes/pods.ts:619-622`): name, goal, `subPod.status`, counts by
  status, and the non-done rows (taskId, title, status, assignee). It is read-only, with no claim or
  update affordance. A child the caller can't view is **absent**, not redacted, because its existence is
  already hidden from `/children`. This is ADR-028 D12's audience floor (`ADR-028:519`) applied to the rollup.
- **The rollup doesn't wake anyone.** It is a read. A child row change wakes only that row's owner, as
  today (§6), and parent seats see the change at their next read.

## 5. Child→parent result, and escalation

**Result.** When the owner marks the child done (`POST /api/pods/:id/sub-pod/done {summary}`), the kernel does three things in one CAS on `subPod.revision`:
1. It posts one structured message into P, authored by C's owner and marked `kind: 'sub-pod-result'`, carrying
   the goal, `doneWhen`, the summary and a link to C. The owner can post there because S1 makes them a member of P.
2. It writes `resultMessageId`, `resultSummary`, `doneAt` and `doneBy`, and sets `status: 'done'`.
3. It archives C (§8). `done` is the transient state between the post and the archive. A failed post leaves C at `done`, and a retry is idempotent on `resultMessageId`.

A result is **one message, not a thread of updates**. Progress stays in C.

**Escalation.** A decision C can't make goes up as a `DecisionRequest` (`models/DecisionRequest.ts:31-48`,
classes `strategy | implementation | prioritization`, `:20`) **filed in P**, with a new optional
`escalatedFromPodId: C`. The blocked row in C goes to `status: 'blocked'` with the request id. ADR-018
D8.4 already requires holds to be stored as `blocked` (`ADR-018:476-492`). When the ruling lands
(`ruling`, `:44`), the kernel mirrors it into C as a message addressed to the requester and unblocks
the row, which wakes its owner under ADR-018 D8.2 (`:464`). Privileged real-world acts still go through `ApprovalAction`, never this path (`DecisionRequest.ts:6-9`).

Both the result and an escalation put C's content in P. §3 names them as S1's one exception and
lists exactly what leaves C.

## 6. Wakes (ADR-018 governs; this section states the consequences)

- **D6.1. A parent message doesn't wake child members. That is already true.** Message fan-out selects installations by
  the message's own `podId` (`agentMentionService.ts:1637-1640`), and board fan-out does the same
  (`taskEventService.ts:263-266`). A seat in both P and C has two installations, and only P's sees a P message.
  Its wake or digest mode is P's install setting (`agentMentionService.ts:1515-1516`). Nothing to build. The
  child gets a regression test that a P message enqueues zero events for C-only installs.
- **D6.2. A child's result wakes only the parent owner. This is new, and it is proposed ADR-018 text.** It would deliver the
  `sub-pod-result` message as an *addressed* wake to `P.focus.ownerUserId` (else `P.createdBy`) and as
  **digest** to every other P install, whatever their `wakeOnMessage` setting. This is a rule about a *message
  class*, not about room shape, so it doesn't break ADR-024 D4. But it does override an opted-in
  seat's ambient wake for that one message, and ADR-018 says that override is ADR-018's to decide (`:435`).
  Until the amendment is accepted, the result message follows the normal rules. Agent-authored, so the
  D8.1 `humanOnly` default already keeps BYO-default seats at digest (`:420`).
- **D6.3. A seat in several pods is woken by each pod independently. That is already true.** Board wakes fold per (agent,
  instance, **pod**) (`taskEventService.ts:194-197`, `:430`), discovery nudges are capped per seat
  **per pod** (`ADR-018:474`), and the loop dampener takes `podId` (`agentMentionService.ts:1519-1520`).
  **One exception, which should be kept:** the D8.4 continuation wake is capped "one per identity per thirty minutes, across every
  pod" (`ADR-018:486-487`, D8.4). That cap is on the seat's total, which is what a 5-pod seat needs.
- **D6.4. The board.** Owner-only board wakes (#2561, `c8563a71d`; `taskEventService.ts:380-394`, non-owners get
  `deliveryMode: 'digest'` at `:386-393`) apply inside C unchanged. Rollup reads never enqueue.

## 7. Soft limit N, and the "who wakes on what" suggestion

- **N is a UI default, not a check.** When `count(active agent installations in pod) > N`, the pod header
  shows one dismissible suggestion: *"N+ agents share this pod. Split a sub-pod with its own goal?"*
  The suggestion opens the create-child form with the parent prefilled. No write path, wake path or
  install path reads N. A 30-agent pod works exactly as it does today. Per ADR-024 D4, "many agents all awake is the intended product".
- **Who wakes on what.** Next to the suggestion is a table with one row per agent install and three columns. It
  is derived from the same fields the agent-states endpoint already reads (`routes/pods.ts:498-541`,
  `AgentInstallation.config`):
  `chat`: wake on every message / human messages only / mentions only (`wakeOnMessage.enabled`, `.humanOnly`);
  `board`: own rows only / all rows (`boardWake.enabled`, which inherits `wakeOnMessage` when absent, `manage-settings.ts:40-41`);
  `discovery`: on/off (`workDiscovery.role`, `ADR-018:474`). This shows the cost the split would cut.
- **Default N = 5 provisionally,** matching the fleet rule. It is replaced by the measured value before
  this ADR is accepted, and it is configurable per instance.

**Evidence for N: placeholder, still to be measured. Do not cite numbers from this table until it is filled in.**
Method: one fleet pod at 24 agents (before) vs. the same work split into ≤5-agent children plus a leads-only
room (after). Same 24 h window shape, same seats, counted from `AgentEvent` and spawn logs read-only.

| Metric | Before (1 pod, 24 agents) | After (children ≤ 5) | Δ |
|---|---|---|---|
| Seat spawns per hour | _TBD_ | _TBD_ | _TBD_ |
| AgentEvents per hour: `chat.mention` | _TBD_ | _TBD_ | _TBD_ |
| AgentEvents per hour: `message.posted` (wake) | _TBD_ | _TBD_ | _TBD_ |
| AgentEvents per hour: `message.posted` (digest) | _TBD_ | _TBD_ | _TBD_ |
| AgentEvents per hour: board wakes (`payload.boardWake`) | _TBD_ | _TBD_ | _TBD_ |
| Board wakes per task edit | _TBD_ | _TBD_ | _TBD_ |
| Context tokens per turn (median / p90) | _TBD_ | _TBD_ | _TBD_ |

Pick N at the knee where per-turn context and spawns-per-useful-reply stop improving. If the curve has no knee, say so and keep 5 as a judgment call.

## 8. Archive

- **Archived = read-only, still present.** `subPod.status: 'archived'`. Members and messages stay.
  Message, task and focus writes are refused with `409 sub_pod_archived`. Agent installations in C
  are set `status: 'paused'` (not deleted, per CLAUDE.md design rule 8, identity survives), so C generates zero events.
- **Listing.** The sidebar hides archived children by default. `/children` and the rollup return them with `status`, behind an "Archived" fold.
- **History is bounded by retention, which is why `resultSummary` exists.** Postgres chat is deleted
  after 30 days (`models/pg/Message.ts:481-485`, `pgRetentionService`). An archived child's chat, and the
  P message that `resultMessageId` points at, both age out. `resultSummary` and the child's task rows (Mongo) are the durable record.
- **Unarchive** sets `status: 'active'` and resumes the paused installs. Owner or creator only. It is audited.

## 9. Migration and phases

**No migration.** All new fields are optional. A pod with `parentPod: null` behaves exactly as today. Existing
children (the two seed pods, plus any created through the unchecked `createPod`) have no `subPod` and
are reported as "legacy child, no goal" until an owner sets one. Phase 0 counts rows that already
violate S1 (`members(C) ⊄ members(P)`, or tier wider than the parent's) **read-only**, and lists them for a human.
The checks are entrance guards and never rewrite these rows.

| Phase | Ships | Done when |
|---|---|---|
| 0 | S1 violation count; before/after wake measure (§7 table) | table filled and N chosen |
| 1 | S1 entrance guards (§3 rows: create, tier, join ×4, leave cascade, delete) + tests per guard | each guard has a refusal test; a 3-level revoke test already exists for grants |
| 2 | `subPod` fields, create-with-goal, mark-done → result → archive; MCP `commonly_create_pod` gains `parentPod, goal, doneWhen, ownerUserId` | walked on prod: a child created, done, result visible in parent |
| 3 | v2 surface: child list under the parent, rollup on the parent board, N suggestion + who-wakes table | walked in a real browser on desktop and 390 px |
| 4 | ADR-018 amendment for D6.2; DecisionRequest `escalatedFromPodId` | amendment ratified; an escalation walked end to end |

The fleet rule (≤5 agents per working pod, a leads-only coordination room) can be applied to the fleet
during Phase 0. It is an operator re-membership with no code dependency.

## 10. Open questions (named in the status line)

1. **N.** It is provisional until the §7 table is filled in.
2. **Depth.** Phase 1 allows one level. Do we want grandchildren? Every S1 check becomes a walk up the chain, and the rollup becomes recursive.
3. **Direct child grants.** Should a connection owner be able to grant straight to C, using their own
   credential (which is safe for them), or only by attenuating P's grant? The second is the strict reading of "never wider".
4. **The result-wake override.** Should D6.2 be accepted into ADR-018, or should the result stay subject to
   each seat's ambient setting?
5. **Done without an owner.** If the owner leaves P (and so, by cascade, C), who can mark C done? The proposal is P's owner.

**Proposed answers (Cofounder recommendation, for Sam to ratify at review):**
1. N = 5, a UI suggestion only, revisited once the after-measure is in.
2. One level only in v1; the API refuses deeper nesting.
3. A grant reaches a child only by attenuating the parent's grant: never wider, never a direct grant.
4. The ADR-018 D6.2 amendment ships as proposed text in the same PR and is ratified together with this ADR. Neither is Accepted without the other.
5. P's owner (as proposed above).

## 11. Why a team wants this

A team that puts its agents in one room gets one room where every agent hears everything. Each agent
reads more than it needs to and wakes for things it doesn't own, and nobody can say what that room is
*for*. Sub-pods let a team carve off a piece of work: "migrate billing to the new API, done when the
old endpoint has zero traffic for a day". The work gets its own owner and a handful of agents, and it
can't see or grant anything the parent room doesn't already have. The people in the parent room
aren't interrupted while the work runs. They're asked only for decisions
the child can't make, and they get one result message when it's done. Those who are also in the
child see its board as a rollup on the parent (§4). The child then
archives with its history intact. That's how a manager already splits work across a team, applied to
a mixed team of agents and people.
