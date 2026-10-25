# ADR-033: The grant record, one portable log of who let which agent do what

**Status:** **Proposed** (2026-10-25). Nothing here is ratified. **Two questions are open, and
neither Proposed nor Accepted settles them:**
(1) **The decision-owner model.** Today approvals are decided by the credential owner, and decision
cards by any human pod member. The spec reserves `decidedByRole: decision-owner` and forbids writers
from emitting it. Who "owns a decision" stays undefined until TASK-512 lands and is walked.
(2) **Who writes `commonly_*` calls.** The spec defines `tool.call {surface: commonly}`, and the
Moonjelly runner writes it for a local seat. Nothing on the server records `commonly_*` calls
(`tool_calls` requires a grant), so "every call is in the record" doesn't hold until TASK-513 ships a
server writer and someone other than its author walks it.

**Spec:** `packages/seats/docs/record-v1.md` at `b7b71f63ae0b3a34d3084d3803056be4f5498a02`
(branch `feat/moonjelly-record`), with the generated sample in `packages/seats/docs/examples/` at the
same sha. Section references below (`spec §N`) are to that file at that sha.
**Where this ADR and the spec disagree, the spec wins.** The tables below use the spec's exact field
and kind names. This ADR decides only which Commonly objects write them.
**Grounded at:** `origin/main` `0ad9d7099` (2026-10-25) for the server code. Code was read, not run.
**Relates to:** ADR-001 (2026-09-11 amendment §3, room grants), ADR-017 / ADR-020 D3 (approval
cards), ADR-018 (attention claims), ADR-025 D18 (relayed outbound identity), ADR-028 D5/D7/D13
(decision ledger, advisory ledger, credential broker), ADR-030 (agent identity).

**Scope boundary.** This ADR decides *which existing objects write* the spec's record, and what the
record does and doesn't enforce. The serialization belongs to the spec. This ADR does not change:
- **ADR-018** (claim, lease and turn-taking semantics). `task.claimed` reports a claim; ADR-018 and
  the board decide what a claim is.
- **ADR-020 D3** (who may resolve an approval card, and that agents never may). The record reports
  the decision and its `decidedByRole`.
- **ADR-028** (work claims and the decision ledger, still Draft). ADR-028 D5 asks *where* decision
  records live and what they carry. This ADR answers a narrower question: in *what format* grant,
  approval and ruling events leave the system. ADR-028 D7 (the ledger is advisory and refuses no
  write) is the same posture as R2 here. ADR-028 D13 (privileged action goes through a broker) is
  the broker R2 names. **Read ADR-028 D5, D7 and D13 before extending either ADR.**
- **ADR-025** (connector substrate). D18 requires the broker to keep the `(agent, on-behalf-of
  human)` pair with the connection, grant and provider result in the action's audit trail. This
  ADR's connector `tool.call` lines are one such trail, but record-v1 has no on-behalf-of field:
  `actor.owner` is whose agent it is, not whom it acts for (spec §1). Until the spec adds one, the
  pair stays in the broker's own store (open question 6). RoomGrant stays the authorization
  boundary, as D18 says.
- **ADR-030** (agent identity, a Proposed stub). The record identifies agents by their instance user
  id (`actor.id`, spec §1), which is local to one instance. This ADR does not make that id portable or
  verifiable off-instance, and it must not be cited as having decided ADR-030's question.
- **ADR-001 amendment §3** (RoomGrant's attenuation and cascade-revoke rules). Those stay
  authoritative.
- **ADR-022 / ADR-023** (persona identity, hosted runtime). The hosted runtime is one more writer.

## 1. Context

A team that lets agents owned by different people act in one room needs one answer to a plain
question: who let which agent do what, and with what result. The individual pieces (running an
agent, keeping secrets out of it, tracing a CLI) are available elsewhere. The piece that is specific
to a shared room is the record that ties them together: access granted per task to an agent owned by
one person, approved by the teammate who owns that decision, visible to everyone's agents in the
room, and recorded next to the claim, the attempt and the result. That record has to be readable by
tools Commonly doesn't own.

Today that record exists in five pieces with different id spaces that don't link:

| Object | Store | What it writes today | What it can't say |
|---|---|---|---|
| `RoomGrant` (`models/RoomGrant.ts`, `services/roomGrantService.ts`, `routes/grants.ts`) | Mongo `room_grants` | `grantId, connectionId, installationId, target{pod\|seat,id}, tools[]` (exact names), `writeMode, budget, audience[], expiresAt, revokedAt, revokedBy, parentGrantId, rootGrantId, brokerId`. `attenuateGrant` mints children; `revokeGrant` calls `RoomGrant.revokeCascade`, which ends a lineage in one write. | No task. No revoke reason. Mutated in place, so history is lost. |
| `tool_calls` (`models/ToolCall.ts`) | Postgres | One row per **connector-grant** call, from `toolBrokerService` and `approvalActionService`. `grant_id NOT NULL`. Outcome `ok\|refused\|pending_approval\|failed`, plus `args_digest`, `credential_owner_id`, `vendor_status`, `vendor_error`, `approval_id`. | `commonly_*` and native calls. No task, no attempt. `pod_id` is `grant.target.id`, a **seat id** for seat grants. |
| `ApprovalAction` (`POST /api/approvals/:id/resolve`) | Mongo | `ownerUserId`, `actionType`, `toolCall{grantId,callId,tool,argsDigest,credentialOwnerId}`, `status`, `decision approved\|declined`, `resolvedBy`, `resolvedAt`, `decidedAfterExpiry`. Human only, owner only (ADR-020 D3). | Its owner is the **credential (connection) owner**, which the broker passes from the connection's creator. No task, no link to a decision card. |
| `DecisionRequest` (`POST /api/activity/decisions/:decisionId/choose`) | Mongo | `agentUserId`, `decisionClass`, `question`, 2–4 `options`, `status pending\|ruled`, `ruling{value,byUserId,byUsername,at,messageId}`. Any human pod member may rule. | No grant, no task, no approval id. |
| `Task` (`models/Task.ts`) | Mongo | `taskId` (`TASK-N`, **per pod**), `podId`, `status pending\|claimed\|done\|blocked`, `claimedBy` (string), `claimedAt`, `claimExpiresAt`, `lapsedFrom`, `prUrl`, `updates[]`. | Current state only; past claims survive as free text. |

## 2. Decision

**D1. One record, defined once.** Commonly's grants, tasks, approvals and decision cards emit
`seats.record` lines exactly as record-v1 defines them. It is the same format the Moonjelly runner
writes for local runs, so one reader opens a local seat's run and the room's server-side history
alike.

**D2. Additive: the record is written next to the stores, not instead of them.** Each object keeps
its schema and enforcement. A writer emits after its own write commits; a failed emit never blocks or
undoes the write. Design rule 2: wrap, don't rewrite.

**D3. Portable means readable outside Commonly.** The record is served per task as JSONL and as the
spec's deterministic OTLP/JSON export (spec §5). It holds no credential values by construction (spec
§3 rule 1), subject to the redact ruling R1.

**D4. The board is the source of truth for claims.** `task.claimed`, `task.released` and `task.done`
mirror the board's transitions (spec §2, Claim). A record line never moves the board. `task.done` is
written by the board (`actor {type: system, id: board}`).

**R1. Redact forwarding is a launch blocker.** Agent-authored text (message chunks, tool titles, and
the `question` of `permission.requested`, which is normally the tool call's title) is scrubbed only of
credential values the writer was given (spec §3 rule 1, and spec §2 Approval for `question`). The
store's `redact()` hook feeds `redactKnownCredentials`, which runs over every string in `data` before
the line is hashed. **No writer that records agent text goes live until the supervisor's trace
wrapper forwards both `actor` and `redact` to the store**, with a test that places a resolved
credential value in agent text and asserts the value never reaches the record bytes. At `b7b71f63`
the store and the valet (`valet/env.js` calls `hook.redact(values)`) carry the hook; no supervisor
wrapper is on that branch, so this is unproven for the supervised path. Writers that record no agent
text (grants, the board) are not gated by R1. Approval writers are gated, because `question` is agent
text.

**R2. Enforcement lives only in the grant broker.** RoomGrant, `assertGrantUsable` and the broker
decide access. The record observes. **A missing `grant.revoked` line is an audit gap, not an access
gap.** The known case: a run settles before its task is marked done, so that run's file never gets
the `grant.revoked {reason: task.done}` line (spec §6, Ana's grant in the sample). The grant is still
dead in the broker; the record can't show it until cross-run linking (spec §6). No reader and no code
path may treat the absence of `grant.revoked` as "still usable", or its presence as proof the process
lost access (spec §2, "What revocation means in v1": an environment credential lasts until the
process exits).

## 3. The record (summary of record-v1 at `b7b71f63`)

**Envelope (spec §1).** One RFC 8785 (JCS) canonical JSON object per line, `\n`-terminated. A
verifier rejects a non-canonical line. An absent field is omitted, never written as `null`; `actor`
and `prev` are the envelope fields where `null` is a value.

| Field | Req | Meaning |
|---|---|---|
| `v` | yes | Integer, `1`. Bumps only on a breaking change (spec §3 rule 3). |
| `schema` | yes | `"seats.record"`. |
| `runId` | yes | `[A-Za-z0-9_-]{6,64}`, the same on every line. One file = one run = one writer (spec §3 rule 4). |
| `taskId` | no | Board `TASK-N`, verbatim. |
| `podId` | **required when `taskId` is set** | Task ids restart per pod; `taskId` is unique only with `podId`. |
| `seq` | yes | **1** on the first line, then +1, with no gaps. |
| `ts` | yes | RFC 3339 UTC, ending `Z`. |
| `kind` | yes | Below. |
| `actor` | object or `null` | `{type: agent\|human\|policy\|system, id, owner?, name?}`. `id` is an id token (`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`), never a display name: a user id for agent/human, `seats` or `board` for system, `grant:<grantId>` or `policy` for policy. `owner` (agents only) is the owning user id. `name` is a display name and never identity. `null` = unknown; readers must not fill it in. |
| `data` | yes | Kind-specific. |
| `prev` | string or `null` | Lowercase hex SHA-256 of the previous line's exact bytes, without its `\n`. `null` on seq 1. Tamper evidence, not a signature (spec §4). |

**Kinds (spec §2).**

| Kind | `data` | Default actor |
|---|---|---|
| `task.claimed` | `{leaseUntil?}` | run |
| `task.released` | `{reason?}`, such as `blocked`, `lease_expired`, `reassigned`, `abandoned` | run |
| `task.done` | `{doneBy?}` (user id). Ends every open grant bound to the task. | `system:board` |
| `grant.issued` | `{grantId, parentGrantId?, scope, target?, issuedBy?, expiresAt?, binding?}`; `scope = {connectionId?, tools: [exact name], writeMode?: read\|write\|write-with-confirm, budget?: {calls?, windowMs?}, audience: [userId]}`; `target = {kind: pod\|seat, id}`; `issuedBy` = user id or `policy`; `binding = {taskId, podId, endsOn: task.done\|expiresAt}`, which must match the run's own `taskId`/`podId`, with `expiresAt` required when `endsOn: expiresAt` | from `issuedBy` |
| `grant.revoked` | `{grantIds: [grantId…], reason}`; reason `task.done`, `expired`, `cascade` (`grantIds[0]` is the revoked ancestor), or `manual`. In a hosted pod, server writers (TASK-513) supply `expired` and `cascade`. | `system` |
| `permission.requested` | `{toolCallId?, options: [{optionId, kind}], question, askedOf: {id, role}, grantId?, decisionCardId?, argsDigest?}`. `question` and `askedOf` are required. `askedOf.id` is an id token and `askedOf.role` is from the `decidedByRole` enum. A call that a rule decides, with no person asked, is asked of the policy: `{id: "grant:<grantId>", role: "policy"}`. | run |
| `permission.decided` | `{outcome: selected\|cancelled, optionId?, kind?, toolCallId, rule: {list: allow\|ask\|deny\|default, pattern}, approval?: approved\|rejected\|timed_out\|failed\|aborted, decidedBy: userId\|"policy"\|null, decidedByRole: credential-owner\|decision-owner (reserved)\|agent-owner\|policy\|null, decisionCardId?, grantId?, argsDigest?}` | the decider |
| `decision.ruled` | `{decisionCardId, value, decidedBy, decidedByRole}`. A ruling on a card **not** tied to a parked tool call. `value` is a string, number or boolean. `decidedBy` is a user id or `"policy"`, and both it and `decidedByRole` are required. | the decider |
| `attempt.started` | `{attempt, adapter, cli?: {name, version}, sessionId?}` | run |
| `attempt.settled` | `{attempt, outcome: ok\|failed\|stuck\|cancelled, failure?: {kind, detail}}` | `system` |
| `run.settled` | `{outcome, failure?, durationMs, attempts}`. Last line. | `system` |
| `tool.call` / `tool.update` | `{toolCallId, title, kind?, status?, name?, surface?: connector\|commonly\|native, argsDigest?}` / `{toolCallId, status?, title?}` | run |
| `credential.granted` / `.denied` | `{names: [ENV_NAME]}` / `{name, reason: not_granted\|unresolved}`. Environment-variable names of a run's start credentials only. | `system` |
| `result.reported` | `{status: done\|partial\|blocked\|failed, refs?: [{type, id}]}` | run |
| run activity | `turn.prompt_sent`, `agent.message_chunk`, `agent.thought_chunk`, `plan`, `usage`, `liveness.*`, `process.exited` | per spec |

**`argsDigest` (spec §2, Tool activity).** `"sha256:"` followed by the lowercase hex SHA-256 of the
arguments' RFC 8785 canonical form, the same serialization as a line. It is allowed only on
`tool.call`, `permission.requested` and `permission.decided`, and a writer refuses any other value.
The same arguments give the same digest on all three, so a reader can match a call to the approval it
ran under. **A digest of low-entropy arguments can be confirmed by guessing them:** it hides values
from a casual reader, not from someone who can guess them.

**Rules (spec §3).** (1) No credential values; agent text is redacted of known values only (R1).
(2) Readers ignore unknown fields and skip unknown kinds, and still verify the chain over them.
(3) `v` bumps only on a breaking change. The 2026-10-25 revision kept `v: 1` and made `question` and
`askedOf` required for writers of `permission.requested`; readers must not assume them on older lines.
(4) One writer per file.

**OTLP export (spec §5)** is deterministic. Task = trace (`traceId` = first 16 bytes of
SHA-256(`"seats.record/trace/task/" + podId + "/" + taskId`)). Run = root span `seats.run`. Attempt =
child span `invoke_agent`. Tool call = child span `execute_tool`. `permission.*` entries are events on
the tool span with the matching `toolCallId`; `decision.ruled` is an event on the span of the request
that carried its `decisionCardId`, otherwise on the current span. Everything else is an event on the
current span. Span ids are the first 8 bytes of SHA-256(`"seats.record/span/" + runId + "/" + seq`)
of the opening entry, with `0` for the run span. GenAI attributes are pinned to
semantic-conventions-genai `9ffc7e00` (Development status); `argsDigest` exports as
`seats.tool.args_digest`.

## 4. Writers and readers

**Server writers (proposed).** Each emits after its own commit, using the spec's kinds:

| Today's object / path | Writes today | Record kinds |
|---|---|---|
| `Task` claim / release / lapse (task routes, ADR-018 sweep) | `status`, `claimedBy`, `claimExpiresAt`, `lapsedFrom` in place | `task.claimed {leaseUntil}` (actor = claimer); `task.released {reason: lease_expired}` from `lapsedFrom`, and `blocked`/`reassigned`/`abandoned` otherwise |
| `Task` → `done` | `status: done` | `task.done {doneBy}` as `system:board`, then `grant.revoked {grantIds, reason: task.done}` for bound grants |
| `roomGrantService.mintGrant` / `createGrant` | `room_grants` row | `grant.issued` (`scope.connectionId/tools/writeMode/budget/audience`, `target`, `issuedBy`) |
| `roomGrantService.attenuateGrant` | narrower child row | `grant.issued {parentGrantId}` |
| `revokeGrant` (→ `RoomGrant.revokeCascade`) | `revokedAt`, `revokedBy` on the lineage | one `grant.revoked`: `reason: cascade` with the ancestor first, or `manual` for a single grant |
| `revokeConnectionGrants` | revokes every grant on a connection | `grant.revoked {reason: manual}`, actor = who disconnected |
| Expiry (`expiresAt` passed) | nothing (checked at use) | `grant.revoked {reason: expired}`, written by the server writer (TASK-513), which holds expiry (spec §2) |
| Broker refuses before the vendor (`refused`) | `tool_calls` row | `tool.call {surface: connector, name, argsDigest}` + `permission.requested {question: <title>, askedOf: {id: "grant:<grantId>", role: policy}, grantId, argsDigest}` + `permission.decided {decidedBy: policy, decidedByRole: policy, rule.list: deny, grantId, argsDigest}` + `tool.update {status: failed}` |
| Broker parks a write (`pending_approval`) + `ApprovalAction` | `tool_calls` row + `ApprovalAction` | `tool.call {argsDigest}` + `permission.requested {toolCallId, options, question: <title>, askedOf: {id: ownerUserId, role: credential-owner}, grantId, decisionCardId?, argsDigest}` (**not** a second `tool.call`) |
| `resolveApproval` | `ApprovalAction.decision/resolvedBy` + `tool_calls` row | `permission.decided {decidedBy: resolvedBy, decidedByRole: credential-owner, approval: approved\|rejected, grantId, decisionCardId?, argsDigest}`, then `tool.update {completed\|failed}` |
| Approval expiry sweep | `tool_calls` `refused/approval_expired` | `permission.decided {decidedBy: policy, decidedByRole: policy, approval: timed_out, grantId, argsDigest}` |
| Broker executes (`ok` / `failed`) with no ask | `tool_calls` row | `tool.call` + `permission.requested {askedOf: {id: "grant:<grantId>", role: policy}}` + `permission.decided {policy, rule.list: allow, grantId}` + `tool.update`, all carrying `argsDigest` |
| `chooseDecision` on a card tied to a parked call | `DecisionRequest.ruling` | `permission.decided {decisionCardId, …}` on that call (spec §2: a ruling on a card a `permission.requested` carried belongs with that request) |
| `chooseDecision` on any other card | `DecisionRequest.ruling` | `decision.ruled {decisionCardId, value: ruling.value, decidedBy: ruling.byUserId, decidedByRole}`. Any human member may rule today, and `decision.ruled` requires a non-null role (the format refuses `null` there). So the writer emits `decidedByRole: agent-owner` when the ruler owns the asking agent; for any other ruler it writes no line, and the ruling stays only in `DecisionRequest` until open question 1 settles. It never emits `decision-owner` as a stand-in. |
| Native runtime (`AgentRun`) | AgentRun subdocs | `attempt.started/settled`, `tool.call {surface: native}`, `run.settled` |
| `commonly_*` calls (CAP via MCP) | **not recorded anywhere server-side** | `tool.call {surface: commonly}` (TASK-513) |
| Moonjelly runner (local seat) | its own JSONL (the spec's reference writer) | everything in the spec |

A rule-decided call is written with a `permission.requested` asked of the grant's policy, as the
spec's sample does for a denied `git push` and an allowed `commonly_post_message`. That keeps one
request/decision pair per call for readers, whichever path decided it.

**`argsDigest` from `tool_calls.args_digest`.** The broker already stores a digest (`digestArgs` in
`models/ToolCall.ts`): bare hex SHA-256 over a key-sorted JSON form. For arguments parsed from JSON
that form matches RFC 8785 (keys sorted by UTF-16 code units, `JSON.stringify` for scalars), so the
writer emits `"sha256:" + args_digest`. They can differ on inputs that JSON can't carry
(`undefined` values, non-finite numbers), so each broker writer ships a test asserting its digest
equals the spec's `argsDigestOf` over the same arguments. Without that test the writer omits
`argsDigest` rather than emit a value that won't match the valet's.

Broker writers never emit `credential.*`: those kinds carry environment-variable names of a run's
start credentials (spec §2, Credentials), and a brokered connector credential is named only by
`scope.connectionId`. `vendor_status` and `vendor_error` have no field in v1 and are not exported.

**Readers.**
- **The room** (shell): the task inspector renders one task's record as a timeline, gated by
  `canViewPod`.
- **Agents**: CAP `GET /api/agents/runtime/pods/:podId/tasks/:taskId/record` (dual-auth, membership
  gated).
- **Outside tools**: `GET /api/v1/tasks/:podId/:taskId/record?format=jsonl|otlp`, for an OTel
  collector.

## 5. The three Trust clauses

**5.1 Per-task grant (TASK-288).** `RoomGrant` gains an optional `binding {taskId, podId, endsOn:
task.done|expiresAt}`. Mint and attenuate accept it, and `grant.issued` carries it. Enforcement stays
in `assertGrantUsable` (R2): a bound grant is usable only while its task is `claimed` by an audience
member, and dies when `endsOn` fires (`done` → revoke with reason `task.done`, through the existing
cascade). An unbound grant behaves as today.

**5.2 Teammate approval (TASK-512).** The approver should be the teammate who **owns the decision**,
not necessarily the credential owner. *Today* `ApprovalAction.ownerUserId` is the connection owner,
and `DecisionRequest` lets any human pod member rule. Writers emit `askedOf.role` and `decidedByRole`
as `credential-owner` for today's approvals. `decision-owner` is reserved in the spec; it becomes
emittable only when TASK-512 defines the role (open question 1) and the spec admits it. A decision
card that carries a parked call's approval links them through `decisionCardId` on both permission
entries. Human only; ADR-020 D3 is unchanged.

**5.3 One openable record (TASK-513).** The three readers join every source in §4 by
`(podId, taskId)`. Acceptance: for one real task, the export opens in a stock OTel viewer and shows
claim → grant → request → decision → attempt → calls → result with no Commonly-specific parser;
hand-editing one line breaks `prev`; re-exporting yields identical bytes.

## 6. What's out (v2, per spec §6)

- **Signing.** v1 proves the file is what its writer wrote, in order; not who wrote it.
- **Multi-writer pod chains.** v1 chains per run.
- **Cross-run linking**, which closes the R2 audit gap.
- **Live revocation** (a brokered credential behind a proxy, so `grant.revoked` takes effect
  mid-process).
- Argument values, even redacted (only `argsDigest`); federation; backfill from before the writers
  ship.

## 7. Consequences

- **Good:** one artifact backs the trust claim, readable by tools we don't own.
- **Good:** additive. No enforcement path moves (R2), so a writer bug costs a missing line, not an
  unauthorized call.
- **Cost:** five writers on three stores can drift from their sources. Mitigation: one reconciliation
  test per writer asserting one line per committed source write.
- **Cost:** per-task grants put a Task lookup into `assertGrantUsable` on the broker's hot path.
- **Risk:** "visible to the room" widens who sees grant metadata (tool names, connection ids, and now
  `question` text and `argsDigest`). leakMatrix tests must cover the new read routes
  (`leakMatrix.grants.test.js` is the template).
- **Risk:** `argsDigest` of easily guessed arguments (a short issue id, a boolean flag) can be
  confirmed by guessing them (spec §2). A room member who can read the record and guess the
  arguments learns them. Readers must not treat the digest as hiding them.
- **Risk:** agent text is redacted of known values only; a transformed value passes (spec §3 rule 1).
  R1 gates launch on the forwarding test, not on the redaction being complete.

## 8. Open questions

1. **Who owns a decision?** TASK-512: task watcher, creator, a pod role, or one the requester names.
   Sam's call. Until then `decision-owner` stays reserved.
2. **Who writes `commonly_*` calls on the server?** TASK-513. `tool_calls` requires a `grant_id`, so
   a writer needs its own source, or `tool_calls` needs a grantless row.
3. **`runId` and file for server writers.** The spec is one file per run, one writer per file. A
   grant or approval isn't a run, and the board writes `task.done` into a run's file in the sample.
   Options: (a) one server `runId` per `(podId, taskId)` with the backend as sole sequencer (a PG
   sequence); (b) server lines appended to the active run. Recommend (a).
4. **Writes with no task.** Most broker calls have no task: a per-pod run with `taskId` absent, or
   left unrecorded until TASK-288 binds them?
5. **Where does the record live?** A PG `record_lines` table or a derived view. Settle together with
   ADR-028 D5.
6. **The ADR-025 D18 pair.** Does record-v1 gain an optional on-behalf-of field on connector
   `tool.call`, or does the pair stay in the broker's own store and out of the portable record?
7. **`surface: commonly` volume.** Every CAP call (heartbeats, reads), or writes only?

## Appendix: conflicts between the code and the fields

Resolved by record-v1 (at `099db50` unless noted):
1. ~~`taskId` isn't unique.~~ **Resolved:** `podId` is required whenever `taskId` is set (spec §1).
2. ~~`endsOn: task.closed` has no kind and no state.~~ **Resolved:** `endsOn` is
   `task.done|expiresAt`, and `task.done` is a kind written by the board.
3. ~~Grant scope (patterns, credential names, no writeMode/budget/audience/lineage).~~ **Resolved:**
   `scope` follows RoomGrant: `connectionId`, exact tool names, `writeMode`, `budget`, `audience`,
   plus `parentGrantId`.
4. ~~`grant.revoked` has no reason or cascade list.~~ **Resolved:** `{grantIds[], reason}`, with
   `cascade` putting the ancestor first. The code still captures no reason, so the writer derives
   it; at `b7b71f63` the spec assigns `expired` and `cascade` to server writers.
5. ~~`decidedByRole: decision-owner` has no source.~~ **Resolved for the format:** `credential-owner`
   is today's role; `decision-owner` is reserved for TASK-512 (open question 1).
6. ~~`actor.id` spaces differ.~~ **Resolved for the format:** `actor.id` is an id token and
   `actor.name` holds the display name. Writers still must map `Task.claimedBy` (a free string) to a
   user id.
7. ~~No canonical bytes / no defined OTLP mapping.~~ **Resolved:** RFC 8785 lines; deterministic
   export.
8. ~~An unlinked decision-card ruling has no v1 kind.~~ **Resolved at `b7b71f63`:**
   `decision.ruled {decisionCardId, value, decidedBy, decidedByRole}`.
9. ~~The broker's `args_digest` has no field.~~ **Resolved at `b7b71f63`:** `argsDigest` on
   `tool.call` and both permission entries, subject to the equality test in §4.
10. ~~A request doesn't say what was asked or of whom.~~ **Resolved at `b7b71f63`:**
    `permission.requested` requires `question` and `askedOf`.

Open, writer-side (TASK-513):
11. **`commonly_*` calls have no server writer.** `tool_calls` requires `grant_id`, so it holds
    connector calls only; `commonly_*` goes unrecorded, and native calls live in `AgentRun`.
12. **`tool_calls` mixes kinds.** `pending_approval` rows are `permission.requested`, and
    approval-refused rows are `permission.decided`, not calls. The trail's derived `superseded`
    outcome must not be exported.
13. **`tool_calls.pod_id` holds a seat id** for seat-target grants. Map `podId` from the grant's
    context, not the column.
14. **`DecisionRequest` rulings have no defined role.** Any human member may rule, which matches no
    `decidedByRole` value except by coincidence (`agent-owner`), and `decision.ruled` refuses a null
    role. Rulings by anyone else are unrecordable until open question 1 settles. See the
    `chooseDecision` row in §4.
