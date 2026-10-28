# TASK-513: server record boundary

Status: server boundary ruled by Lily on 2026-10-25 at 15:45:17Z, decision
`6ade1e1d22a5cac4a3985799` (pod message 86051): **Task and pod chains**.
The CTO's 10-25 launch plan (task note, 2026-10-26 04:09Z) settles the two
items this document left open: record-v1 and its writer are on main
(`packages/seats`, #2739), and server lines carry no `argsDigest` at launch.

Slice 1 (TASK-559) implements the store, the board's lines and the read
endpoint. Every writer and the endpoint are off unless the pod is listed in
`RECORD_V1_PODS`; nothing is public until a non-author walks it (slice 4).

| slice | row | scope |
|---|---|---|
| 1 | TASK-559 | migration 0002, chain store, vendored writer, board lines, `GET /api/pods/:podId/record/tasks/:taskId` |
| 2 | TASK-560 | grant lines and the B1–B5 connector mappings |
| 3 | TASK-561 | `commonly_*` lines, a client-declared tool name checked against the route |
| 4 | TASK-562 | v2 view, browser checks, non-author walk |

### Decisions taken in slice 1

- **One writer implementation, two copies.** The backend image builds from
  `backend/` alone and is CommonJS; the writer is ESM in `packages/seats`.
  `backend/vendor/seats/src` holds byte-identical copies of `format.js`,
  `otel.js` and their imports, and a unit test fails when a copy differs or a
  copied file imports one that was not copied. `npm run sync:seats-record`
  refreshes them. The alternative, a second Docker build context, touches
  every place the backend image is built (deploy-dev, deploy-staging, the kind
  smoke test, both compose files).
- **runId per chain** is `srv-task-<32 hex>` or `srv-pod-<32 hex>`, a SHA-256
  over the pod and task (ADR-033 §8 q3, option a). The chain row stores it.
- **The head is stored beside the lines** (`record_chains.head_seq`,
  `head_hash`) and served as `X-Record-Head` / `X-Record-Entries`, the spec's
  outside record of the last line (§4).
- **Readers.** `canViewPod` decides existence (404 otherwise, so the route
  confirms nothing). Lines then go to actual pod members only, agents
  included. They carry approver and credential-owner ids verbatim, and a
  hash-chained line cannot be redacted without breaking verification; those
  are the ids `runTraces` withholds from admins and agent-DM observers, so
  those readers get a 403.
- **Board lines** mirror committed transitions: a fresh claim, a takeover, a
  resumed blocked task, or a holder's note that restores a lapsed claim writes
  `task.claimed`; a renewal by the holder writes
  nothing; blocking a claim or a lapsed lease writes `task.released`; every
  path to done writes `task.done` with the board as actor. Reopening and
  unblocking have no record-v1 kind and write nothing. `leaseUntil` comes only
  from a write that set a lease (a claim, a restoring note). A PATCH to
  `claimed` sets no lease, so its `task.claimed` line carries empty data. Each line is keyed by the row's
  persisted `updatedAt`, which the revision CAS advances on every write.
- **Emission** runs after the source write commits, queued per chain in each
  process so one process appends in commit order, and never changes the
  source write's result.

### Decisions taken in slice 2 (TASK-560)

- **Where each line comes from.** The broker's trail write (`recordCall`)
  emits B1 (refused), B2 (parked, asked of the credential owner, on its card)
  and B5 (run under the grant with no ask). A trail row that carries an
  approval id and is not the park is the run of an approved call. The approval
  resolver records that, so it is skipped here, and no call gets two terminal
  decisions. The resolver writes B3 once the ending is saved: the decision by
  the credential owner, then `tool.update` from the saved ending. Expiry at
  decide time and in the sweep writes B4. Both read the decider the approval
  row stored with its terminal write (`decidedBy`, `decidedByRole`, TASK-512),
  never the caller. A row whose stored decider is missing, or does not fit its
  outcome (B3 needs `credential-owner`, B4 needs `policy`), writes no lines and
  logs a warning: an audit gap, not a guessed decider.
- **Pod-target grants only.** A seat grant's target is a seat and its card
  sits in the granter–seat DM, so neither names the pod a call belongs to.
  Those calls write nothing until a pod is ruled for them. The seat tests run
  with the pilot gate open everywhere, so only this rule can refuse them.
- **Grants.** `grant.issued` comes from the two routes that mint, because the
  mint itself has no issuer: the connection owner as a person, the attenuating
  agent as an agent. `RoomGrant.revokeCascadeMoved` returns the grants one
  revoke moved, and `revokeGrant` passes them to the recorder (it returns
  only their count). One line per pod gives `manual` when the
  revoked grant went alone and `cascade` (ancestor first) when descendants went
  with it. Expiry is written the first time the server sees an expired grant
  (at use, or as a lineage parent), keyed so it is written once, with the
  server as actor (`system`/`commonly`). Nothing sweeps expiry, so a grant
  nobody uses again gets no line; R2 makes that an audit gap, not access.
- **No `argsDigest`** on any line, JSONL or OTLP (CTO, ADR-033 §8 q9).
- **Reads.** `GET /api/pods/:podId/record` serves the pod's taskless chain
  under the same gate as the task route.

## Measured inputs (2026-10-25)

- TASK-504 landed in #2684, merge `ab5132313ad399d8fb990d69bc39db0ccf99e055`.
- record-v1 is `packages/seats/docs/record-v1.md` on
  `feat/jellymoon-record` at `fb686d4fdd3143d5fa5f4fbeb43f46c38c3cbf90`.
  Its reference writer, verifier, OTLP exporter and digest vectors share that
  commit. The package is not on the implementation base, `2b0ea6689`.
- ADR-033 at `e2c89e2f0a1032f210d581545054ed7e7d728ef4` remains Proposed.
  Section 8 explicitly leaves the server run, taskless calls, storage and CAP
  capture breadth open. These are decisions, not fields supplied by a caller.
- `RoomGrant` and `ToolCall` on this base have no task binding. A seat grant's
  target id is a seat, so it cannot supply a pod id. `commonly_*` requests have
  no shared task or run context in their HTTP client.
- `runTraces.ts` already provides a human-readable run view. It permits
  `canViewPod` readers but withholds grant and credential-owner identities from
  readers who are not actual origin members. A new record reader must state
  its treatment of those identities explicitly.

## Ruled boundary

Use a server-owned PG chain per `(podId, taskId)`, with the backend as the sole
logical writer and transaction serialization across replicas. Give taskless
calls a separate pod chain, omitting `taskId`; do not guess the task from the
agent's most recent claim. A caller's optional task context must be validated
against server state before any line receives that task id. The exact grant
binding contract is shared with TASK-288.

Capture metadata for every authenticated `commonly_*` call, reads included,
plus connector calls. Store the exact allowlisted tool name, actor, server
timestamp and outcome. Omit `argsDigest` from every server record line and
JSONL/OTLP export under the interim launch rule below. Do not store arguments,
response bodies, credentials, arbitrary headers or exception prose. A request
must not select another agent's identity, a foreign pod, or an unrelated task.
Requests without an attributable pod need a separately ruled boundary; never
invent a pod from a seat id or a grant id.

Persist canonical record-v1 bytes at emit time, after the source write commits.
A per-chain lock and atomic head update preserve consecutive sequence numbers
and `prev` across replicas. Repeated delivery of one source event is idempotent.
A record failure leaves the original authorization/effect unchanged and emits
a bounded operational error. Readers return an error for unavailable storage;
they never present an outage as an empty complete record.

Reuse the reference format/verifier/exporter from the pinned shared package.
Do not introduce a second serializer or copy an untracked implementation.
Coordinate its landing or a shared module extraction with its owner.

Emit grants, approval requests and decisions, task transitions and tool events
with the ADR's B1–B5 mappings. Derive actors from authenticated identities and
committed source rows. Keep credential-owner approval unchanged and keep
`decision-owner` reserved. Do not add approval text until the known-credential
redaction path has its required end-to-end proof.

Expose task records through the task's existing authorization boundary, with
current `canViewPod` checks before loading record bytes. Explicitly test and
document the treatment of admin/observer readers, public pods and forwarded
approval cards. Follow origin pod links, not the card's display pod. Reuse the
existing run-trace presentation where it fits; add one task or decision entry
point and JSONL/OTLP export, with English and Chinese copy.

## Ruling and remaining integration dependencies

Lily chose task and pod chains over real agent-run chains or a task-only first
slice. That settles sequencing ownership, taskless capture and breadth: one
backend-sequenced PG chain per task, separate pod chains for taskless calls,
and every pod-attributable commonly call, reads included. Explicit validated
context is required; a recent task claim is never a task-binding source.

Implementation reuses the shared record-v1 writer/verifier/exporter, now on
main via #2739 and vendored byte-identically as described above. ADR-033 (#2691)
is marked Accepted but not merged. Its approval and stored parked-call binding
rules (D5) gate slice 2's approval lines, not slice 1.

## Interim digest rule (2026-10-25)

Rivet's handoff in pod message 87089 pins proposed ADR-033 §8 question 9 at
`d2dbd42bae7819b76c70e5972ddfe90f4981e2a4`. TASK-513 adopts its interim
launch rule: omit `argsDigest` from **all** server record lines and exports,
including B1–B5. Do not copy broker-internal `tool_calls.args_digest` into the
record. That internal value remains unchanged for approval integrity.

CTO owns the later privacy decision between a separately specified keyed field
and omission for low-entropy tools. Do not add a keyed value to v1's `sha256:`
field: its canonical unkeyed meaning is fixed. Digest emission remains disabled
until the decision and conformance/privacy tests are accepted. An absent digest
never means a call had no arguments. The ADR remains Proposed; this handoff does
not ratify the rest of it or enable a writer.

## Required evidence before enablement

1. Shared writer/verifier round-trip and deterministic OTLP bytes; editing a
   line breaks verification. Assert `argsDigest` is absent from persisted server
   lines, JSONL and OTLP for every emitted kind, including B1–B5, even when the
   source broker row has `args_digest`. A future digest field requires the
   accepted privacy decision and all shared conformance vectors first.
2. Real PostgreSQL concurrent appends, idempotent replay, rollback on failed
   head update and upgrade from the populated prior schema.
3. Cross-pod/task denial with no content read, public nonmember denial,
   current membership removal, forwarded card origin checks and both auth
   shapes. Test admin/observer identity redaction explicitly.
4. A real committed source write per grant, attenuation, revocation, expiry,
   parked/approved/declined/timed-out call, task claim/release/completion, and
   both connector and commonly tool surfaces. No duplicate terminal decision.
5. A taskless call remains taskless. Two concurrent tasks for one agent never
   misattribute calls. Invalid context cannot widen access or forge an actor.
6. No resolved credential reaches record bytes; no request/response body or
   vendor error text appears. An audit-store failure does not change the
   source operation and never yields a successful empty export.
7. Real-browser checks at 390 and 1440, then a non-author walk of one real task
   from claim through result, including JSONL and a stock OTLP viewer. Independent
   Tier 2 code/security gates precede enablement. The author does not self-gate.
