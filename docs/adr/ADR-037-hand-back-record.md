# ADR-037: Review before the PR, and a hand-back record a named teammate accepts or refuses

**Status:** **Accepted** 2026-11-26 (F654), ratified by the maintainers under the founder's standing
delegation, including §4's refusal in one-human pods. Nothing here is built yet. Acknowledged unknowns
are in §8; accepting this ADR does not settle them.

**Number.** ADR-031 was claimed by PR #2428 (closed unmerged) and ADR-036 by open PR #4223, so this
takes 037.

**Grounded at:** `origin/main` `3e845e1d8` (2026-11-26). Code was read, not run.

**Relates to:** ADR-004 (CAP, its decision-request route and conformance finding C1), ADR-011
(shell-first), ADR-018 (claims are leases, unchanged), ADR-020 D3 (agents never resolve approval
cards), ADR-025 D18 (the `(agent, on-behalf-of human)` pair), ADR-028 D5 (where decision records live),
ADR-030 (agent identity, a stub), ADR-033 (the grant record and its `actor.onBehalfOf`), ADR-034 D4 (no
new Mongo model).

**Scope boundary.** This ADR decides:
- a user-space dev workflow, the *hand-back*, with its record, write rules and CAP convenience routes;
- four general extensions to decision cards that any card may use (§2). These change
  `decisionRequestService.chooseDecision` and `attentionItemService.recordDecision`.

It does not change:
- claim and lease semantics (ADR-018);
- the record-v1 serialization (ADR-033). Emitting hand-back lines into the record chain is deferred (§7);
- how an agent's identity is made portable (ADR-030).

**Scope note against ADR-011.** ADR-011 keeps kernel feature work paused. This ADR lifts none of its
paused tracks: not the CAP spec, not ADR-010 Phase 2, and not driver expansion. The hand-back sits in
the user-space layer of the CLAUDE.md diagram ("Dev workflows") and is served by additive CAP
convenience routes, which ADR-004 §What's NOT part of CAP keeps outside the minimum surface. The only
kernel changes are the four decision-card extensions, each small and useful to any card. The
reactivation triggers in ADR-011 stay as written.

## 1. Problem

People distrust a pull request an agent made for two reasons. Nobody looked at the plan before the code
was written, so a wrong approach is found only after the work is done. And nobody accountable reviewed
the result: the person who asked, or who owns the agent, reads its summary, and that summary mixes what
the agent checked with what it only assumed. Commonly already moves work between people's agents in one
pod, and a person can answer a decision card. What's missing is a record that names a second person
before the work starts, and then carries what was asked, what was planned, what changed, what was checked
and what wasn't, so that person can accept or refuse it with a reason.

What this is not:
- **Not a code-review tool.** The record links to a PR, commits or files. It doesn't render diffs,
  comment on lines or run checks.
- **Not a GitHub replacement or merge gate.** An accepted hand-back doesn't approve or merge a PR.
  ADR-030 §3 explains why agents can't be separate GitHub reviewers today; this ADR doesn't change that.
- **No file locks.** Two agents may still edit the same files. The record reports what happened; it
  prevents nothing. Task leasing stays ADR-018's.

## 2. Placement: user space on the kernel

**User space (new):**
- the `hand_backs` table;
- `handBackRepository.ts` and `handBackService.ts`;
- the CAP convenience routes and MCP tools in §5;
- the shell card.

The service drives decision cards and the event queue as an ordinary client of the kernel.

**Kernel: four decision-card extensions (new, general).** Each is optional on `DecisionRequest`
(`backend/models/DecisionRequest.ts`) and server-set. The agent route `POST /api/agents/runtime/decisions`
already refuses unknown body fields, so `commonly_request_decision` can't set them. An internal caller
such as `handBackService` can.

| Extension | Effect on any card that sets it |
|---|---|
| `ruling.reason` | Stored with the ruling. Posted in the ruling reply. Added to the `decision.ruled` payload as `reason` |
| `allowedValues: [{ value, reasonRequired }]` | `chooseDecision` refuses a value outside the list (`400 value_not_allowed`), and a missing or empty reason where one is required (`400 reason_required`), on every path |
| `deciderFallback: 'none'` | When no named decider is still in the pod, nobody else may rule (`403 not_a_decider`), and `recordDecision` writes no attention rows for the other members. The default stays `'members'`, today's behaviour |
| status `closed` | A third status beside `pending` and `ruled`. `chooseDecision` refuses any card not `pending` (`409 decision_closed`), and `recordDecision` skips it |

**The subject link.** A card can carry an optional server-set `subject: { type, id, stage }`, which
points at what the card decides. Before posting a ruling, `chooseDecision` runs the stage check
registered for the card's `subject.type`. For `hand_back`, `handBackService` registers a check that
reads the linked record and refuses with `409 subject_stage_mismatch` unless:
- for the plan card, the record is `plan_sent`;
- for the result card, the record is `handed_back`.

This covers a stale card left behind after a withdraw and a resend to a new reviewer. It's a fifth
field, which the stage check needs. The subject's service registers the check, so `chooseDecision`
names no workflow.

**The check fails closed.** If no check is registered for a card's `subject.type`, `chooseDecision`
refuses the ruling (`409 subject_check_missing`). Checks register at server boot, not on a module's
first import, because the Slack and Telegram path loads `chooseDecision` lazily (`decisionCardReply.ts`)
and could otherwise run before the hand-back module has loaded.

**Kernel reuse, unchanged:**
- **Attention.** `attentionItemService.recordDecision` writes the named decider's Needs-you row. It
  honours `deciderFallback` and `closed` as above, and so does `backend/scripts/backfill-attention-items.ts`,
  which calls `recordDecision` for `DecisionRequest.find({ status: 'pending' })`.
- **Agent events.** `AgentEvent` gets one new type, `handback.received` (§3).

**Shell:**
- `V2DecisionCard.tsx` shows only the allowed values, and a reason box when a reason is required;
- a new hand-back card renders the five fields;
- Activity (`V2ActivityPage.tsx`) needs nothing new, because the reviewer's row is an ordinary
  `decision` item.

**What is new, in full:**
- **Kernel:** the four extensions, the subject link, the `chooseDecision` and `recordDecision` changes,
  `reason` on `decision.ruled`, and the `handback.received` event type.
- **User space:** the `hand_backs` table, repository and service. The routes are
  `POST /api/agents/runtime/pods/:podId/hand-backs`, `POST /api/agents/runtime/hand-backs/:id/hand-back`,
  `GET /api/agents/runtime/hand-backs/:id`, `POST /api/hand-backs/:id/withdraw` and
  `GET /api/pods/:podId/hand-backs`. Then the four MCP tools, the reconcile sweep, and the shell card.

## 3. The record

**Storage.** A new Postgres table `hand_backs`, in a numbered migration in `backend/config/migrations/`
(the next free number when it's built; `0026` is the highest on `origin/main` today), read and written
through `backend/repositories/handBackRepository.ts`. It's Postgres-only, like `tool_calls` and
`record_chains`, because ADR-034 D4 fails CI on a new Mongo model.

**Why not extend an existing model:**
- `Task` is Mongo. Any write member can PATCH its `prUrl` and `notes`, and its `updates` is an
  append-only list of free text added through `POST /:podId/:taskId/updates`. Neither can hold
  structured, write-once fields owned by specific actors.
- One task can have several attempts, and a hand-back can exist with no task.
- `DecisionRequest` is one question. A hand-back owns two cards and the work between them.

| Field | Contents | Written by | When |
|---|---|---|---|
| `id`, `pod_id`, `thread_root_id` | where the record and its cards live | server | plan-send |
| `task_id` | optional board row in the same pod (checked to exist) | agent | plan-send |
| `author_agent_user_id` (+ `agent_name`, `instance_id` for display and events) | the author agent, keyed on its User id from `req.agentUser._id` and never on the installation | server | plan-send |
| `owner_installed_by`, `owner_user_id` | both owner sources: the active `AgentInstallation.installedBy` and `botMetadata.ownerUserId`, each null if it isn't a human | server | plan-send |
| `asked` | `{text, requesterUserId, requesterAgentUserId?, provenance: 'message' \| 'task' \| 'owner'}` | agent writes `text`; server derives the rest (below) | plan-send |
| `reviewer_user_id` | the named reviewer | agent names; server enforces §4 | plan-send |
| `plan` | `{text}` | agent | plan-send |
| `plan_decision_id`, `plan_ruling` | the card, and `{verdict, reason, byUserId, at}` copied from it | server | plan ruled |
| `next` | optional agent `{agentUserId, agentName, instanceId}` that continues on acceptance; must be installed in the pod | agent | plan-send |
| `changed` | `[{kind: 'pr' \| 'commit' \| 'file' \| 'message' \| 'url', ref, note?}]`, one or more | agent | hand-back |
| `checked` | `[{what, how}]` | agent | hand-back |
| `unverified` | `[{what, why?}]`, required, may be empty | agent | hand-back |
| `handback_decision_id`, `handback_ruling` | as for the plan | server | hand-back ruled |
| `supersedes` | id of a refused or withdrawn record this one redoes | agent | plan-send |
| `status`, `withdrawn_by`, timestamps | state | server | every step |

**The requester is derived; the agent can't choose it.** The server uses the first of these that
resolves:
1. **`asked.sourceMessageId`.** It must be a message delivered to this agent as a wake. The check is an
   `AgentEvent` row with:
   - the author's `agentName` and `instanceId`, and `podId` equal to this pod;
   - type `chat.mention`, `thread.mention` or `message.posted` (the `WAKE_TYPES` in
     `agentAnswerService.ts`);
   - status `delivered` or `acked`;
   - `payload.messageId` equal to the id, or the id among the messages that event coalesced.

   Otherwise it's refused with `400 source_not_delivered`. This check only reaches back as far as the
   rows that still exist, and two things remove them:
   - delivered and acked rows are deleted after 168 hours by default
     (`AgentEventService.garbageCollect` in `agentEventService.ts`,
     `AGENT_EVENT_DELIVERED_RETENTION_HOURS`);
   - digest-mode events are folded into a digest and deleted (`agentDigestFoldService.ts`).

   So a plan citing an older message, or a digest-folded one, is refused `source_not_delivered`. The requester is that message's author. If
   the author is an agent, the requester is that agent's human owner, and the agent is kept as
   `requesterAgentUserId`.
2. **`taskId`.** That task's `createdByUserId`. An agent creator maps to its human owner the same way.
3. **Neither resolves:** the requester is the author agent's owner, with provenance `owner`. The card
   shows this weaker case visibly ("requester: the agent's owner, no source message"), so the reviewer
   can see it.

Any path that ends at a bot or at no human is refused with `422 requester_unresolved`. What's enforced:
the requester is a person the server found from a delivered message, a task row or the ownership
records, never from a value the agent typed. What isn't enforced: that this person is the one who
really meant the work, as opposed to the one whose message woke the agent.

> **NOTE.** "Not a bot" means `User.isBot` is false. An account flagged as human but operated by an
> agent defeats every person check in this ADR. Detecting that is out of scope.

**Write-once.** Agent fields are write-once. A correction is a new record with `supersedes`. When
`unverified` is empty, the card shows "The agent listed nothing as unverified".

**States.**

```
plan_sent ──Accept──▶ plan_accepted ──hand-back──▶ handed_back ──Accept──▶ accepted
    │                       │                           │
    └──Refuse──▶ plan_refused    (withdraw from any       └──Refuse──▶ refused
                                  non-terminal state ──▶ withdrawn)
```

**Integrity.**
- **Every transition is a compare-and-set:** `UPDATE hand_backs SET status = $new, … WHERE id = $id AND
  status = $expected RETURNING *`. Zero rows returned means another writer won, and the caller gets
  `409 stale_state`. A ruling's copy also matches the card:
  `AND plan_decision_id = $decisionId` (or `handback_decision_id`).
- **Copying a Mongo ruling into Postgres.** After `chooseDecision`'s final `findOneAndUpdate` marks a
  card `ruled`, it calls the subject's registered on-ruled hook, `handBackService.applyRuling(decision)`.
  The hook:
  - runs the compare-and-set above;
  - on `accepted` with `next` set, enqueues `handback.received`.

  Only the writer that wins the compare-and-set enqueues, so the event fires once.
- **Reconciling a failed copy.** The Mongo ruling is the source of truth for the verdict. If the hook
  throws, the ruling stands on the card and the record is behind. Two paths catch it up, each running
  the same `applyRuling` compare-and-set:
  - every read of a record (`GET` routes, the withdraw route) re-derives a `plan_sent` or `handed_back`
    record from its linked `DecisionRequest` and applies the ruling if that card is `ruled`;
  - a `schedulerService` sweep does the same for open records whose card is ruled. It also moves a
    still-`pending` card to `closed` when its record is `withdrawn`, which covers a failed second step
    of withdraw.
- **Withdraw.** The route first moves the record to `withdrawn` by compare-and-set from any
  non-terminal state, then moves the open card `pending → closed` with a conditional update, which
  resolves its attention row through `attentionItemService.resolve`. If a ruling races in between,
  the subject stage check refuses it. A ruling that has already finalized stays on the card, and
  `applyRuling`'s compare-and-set doesn't copy it.
- **One message for the plan card.** The plan is posted once, as the decision card's own source
  message: `handBackService` calls `requestDecision`, which posts as the agent. `requestDecision` gains
  an internal metadata pass-through, so that message carries `metadata: { source: 'decision-request',
  kind: 'hand-back', handBackId }` and the shell renders the hand-back card with the decision card
  inside it. The result card works the same way. There is never a second plan message to keep in step.

**Reads.** Any pod member can read a record:
- humans via `GET /api/pods/:podId/hand-backs`, which calls `DMService.canViewPod`;
- agents installed in the pod via the CAP read.

## 4. The reviewer rule

The reviewer is one named person who is:
- not a bot;
- a listed member of the pod (`isListedPodMember`);
- not the requester;
- not `owner_installed_by`;
- not `owner_user_id`.

Both owner fields are checked because `lookupInstaller` today takes `installedBy` first and
`ownerUserId` only as a fallback, and a person who holds only the second is still the agent's owner.
Plan-send refuses `422 owner_unresolved` when neither field resolves to a human. ADR-004 C1 means
`installedBy` can be the agent itself, which is why that case counts as unresolved.

**Enforcement** happens at plan-send in `handBackService`, before any message is posted:
`400 reviewer_ineligible`, with a sub-code naming the failed rule. The reviewer becomes the card's only
decider, with `deciderFallback: 'none'`. Without that, `chooseDecision` lets any member rule once the
named deciders leave, which could hand the ruling to the requester or the owner. With it:
- the card waits;
- the author agent or the owner can withdraw it and send the plan again with a new reviewer, as a new
  record with `supersedes`.

**A pod with one human: refuse.** Plan-send answers `409 no_eligible_reviewer`. The server message says
only to invite a reviewer into the pod. The MCP tool's description adds the single-person alternative
it can name on that surface, `commonly_request_decision`. A runtime without that tool isn't pointed at
it.

Two alternatives were considered and rejected:
- **Falling back to the requester** would make "a second person accepted this" false on some records.
- **Warning and continuing** would leave a flag every reader has to check.

For the same reason there are no records in `agent-room` or `agent-dm` pods: `DM_POD_TYPES_GUARD` caps
them at two members, so neither can supply an eligible reviewer. Agents may coordinate in a DM
(`commonly_dm_agent`) and keep the record in the team pod.

## 5. Agent surface, and how a ruling is made

These are CAP convenience routes. Identity comes from the runtime token, never from the body.

| MCP tool (new) | Route (new) | Arguments → result |
|---|---|---|
| `commonly_send_plan` | `POST /api/agents/runtime/pods/:podId/hand-backs` | `{ reviewerUserId, asked: { text, sourceMessageId?, taskId? }, plan, threadRootId?, next?: { agentName, instanceId? }, supersedes? }` → `{ handBack: { id, status: 'plan_sent', decisionId, messageId } }` |
| `commonly_hand_back` | `POST /api/agents/runtime/hand-backs/:id/hand-back` | `{ changed: [{ kind, ref, note? }], checked: [{ what, how }], unverified: [{ what, why? }] }` → `{ handBack: { id, status: 'handed_back', decisionId, messageId } }` |
| `commonly_get_hand_back` | `GET /api/agents/runtime/hand-backs/:id` | `{}` → the full record |
| `commonly_withdraw_hand_back` | `POST /api/hand-backs/:id/withdraw` (`dualAuth`) | `{ reason? }` → `{ handBack: { id, status: 'withdrawn' } }` |

- `reviewerUserId` is the `userId` that `commonly_get_context` lists for each member.
- **Hand-back and withdraw: who may call.** Only the author can hand back: the token's
  `req.agentUser._id` must equal `author_agent_user_id`. Withdraw takes `dualAuth`: either the author
  agent's runtime token (same check), or a human JWT whose user is `owner_installed_by` or
  `owner_user_id`.
- **Events.**
  - The author agent gets `decision.ruled`, now carrying `reason`, plus an additive `handBack: { id,
    status }`.
  - The next agent gets `handback.received`, carrying the record id plus `asked`, `plan`, `changed`,
    `checked` and `unverified` in full, so it needs no second read.

**The verdict and reason are enforced on the server on every path.** Hand-back cards set
`allowedValues: [{ value: 'Accept', reasonRequired: true }, { value: 'Refuse', reasonRequired: true }]`.
`chooseDecision` applies this whatever the origin: the web route (`routes/activity.ts`), or a Slack or
Telegram reply through `decisionCardReply.ts`. A channel reply can't carry a separate reason. A hand-back
card's channel reply is refused with `reason_required`, and the bridge answers with a link to rule in
the pod.

**Runtimes.** Phase 1 is the MCP server only (`commonly-mcp/src/tools.js`, serving every BYO CLI
wrapper). CLAUDE.md warns that a `commonly_*` name doesn't identify a capability across runtimes. So:
- the PR checks these four names are unused on the native preset and in the cli adapter lists
  (`cli/src/lib/enforcement.js`, `cli/src/lib/adapters/goose.js`);
- the docs say the tools are MCP-only.

Native and the openclaw extension get nothing yet.

## 6. Identity and accountability

Each transition stores both the actor and the person it acted for:
- **plan-send and hand-back:** the author agent, both owner fields, and the derived requester;
- **rulings:** the reviewer;
- **withdrawal:** `withdrawn_by`, either the agent or the owner.

This pair has the same shape as record-v1's `actor.owner` and `actor.onBehalfOf` (ADR-033) and ADR-025
D18, so a later writer can emit it without remapping.

Boundary:
- The record stores the pair, and it enforces only what §3 and §4 state.
- The owner fields inherit ADR-004 C1.
- Making every agent action, beyond this record, carry the person it acted for, and making agent
  identity verifiable off-instance (ADR-030), are separate work. This ADR must not be cited as deciding
  either.

## 7. Phasing

**Phase 1: one pod, end to end, over MCP.** A pod with two people, A and B, and their agents, both on MCP
wrappers:
1. A asks A's Claude Code agent; it calls `commonly_send_plan` with A's message as `sourceMessageId`,
   B as reviewer and B's Codex agent as `next`;
2. B accepts with a reason;
3. A's agent hands back with a PR link;
4. B accepts or refuses with a reason;
5. on accept, B's agent receives `handback.received` with the five fields.

In Phase 1:
- the four decision-card extensions, the subject link, and the `chooseDecision`, `recordDecision` and
  backfill changes;
- the table, repository, service, routes and the four MCP tools, including withdraw;
- `applyRuling` with its read-path reconcile and sweep;
- the reason box in `V2DecisionCard.tsx` and the hand-back card;
- bridge replies in `decisionCardReply.ts` for `400 reason_required` and `value_not_allowed`, and for
  `409 decision_closed` and `subject_stage_mismatch`.

Tests:
- service-tier tests for every reviewer and requester refusal code;
- a ruling on a withdrawn (closed) card is refused;
- a ruling on a card whose record is at another stage is refused;
- a Slack or Telegram ruling without a reason is refused;
- an owner known only through `botMetadata.ownerUserId` is refused as reviewer;
- `deciderFallback: 'none'` holds when the reviewer leaves, in both `chooseDecision` and `recordDecision`;
- a lost compare-and-set returns `stale_state`;
- a failed `applyRuling` is caught up on read;
- write-once fields;
- a hand-back can't skip `plan_accepted`.

The walk is the five steps above, plus the one-human refusal, done by someone other than the author.

**Deferred:**
- native tools, with `verify:preset-tools` coverage;
- task-update lines on the board;
- people as authors (a shell form and a JWT route);
- reassigning a reviewer in place, and a separate reviewer for each stage;
- a hand-back by an agent other than the author;
- ADR-033 record lines;
- a Needs-you label;
- ruling with a reason from Slack or Telegram;
- surfacing records on a GitHub PR;
- the openclaw extension.

## 8. Acknowledged unknowns

- **Whether refusing one-human pods keeps the feature from being used where it matters.** No usage data
  exists. Once Phase 1 ships, each weekly read counts how often `no_eligible_reviewer` fires, and the
  revisit uses those counts.
- **Whether `commonly_get_context` should list eligible reviewers for a given request as a preflight,**
  so an agent picks one before a refusal. It's cheap, but it puts workflow-specific data in a kernel
  read. Considered, not decided.
- **Whether a plan review is always worth its wait.** Phase 1 has no skip path.
- **Whether agents fill `checked` and `unverified` truthfully.** The record makes the claim attributable,
  not true. Nothing checks it against CI or the PR.
- **Text caps.** The card reuses `DecisionRequest`'s 1000-character question and 2000-character context
  limits. The record's own caps are set in the implementation PR.
- **The decision class.** Phase 1 uses `decisionClass: 'implementation'`. A separate `review` class is
  open.
- **ADR-004's `metadata.kind`.** ADR-004 says `metadata.kind` is the only kernel-inspected metadata field
  and lists values like `install-intro`, but doesn't say whether the set is closed. Adding `hand-back`
  either needs that ADR amended to name a closed list, or confirmed as open.
- **ADR-028 D5.** Where this table sits once D5 settles where decision records live.
