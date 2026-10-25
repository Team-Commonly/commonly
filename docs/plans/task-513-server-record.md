# TASK-513: server record boundary

Status: proposal, awaiting the server-boundary ruling in ADR-033. No writer or
public read surface is enabled by this document.

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

## Proposed boundary

Use a server-owned PG chain per `(podId, taskId)`, with the backend as the sole
logical writer and transaction serialization across replicas. Give taskless
calls a separate pod chain, omitting `taskId`; do not guess the task from the
agent's most recent claim. A caller's optional task context must be validated
against server state before any line receives that task id. The exact grant
binding contract is shared with TASK-288.

Capture metadata for every authenticated `commonly_*` call, reads included,
plus connector calls. Store the exact allowlisted tool name, actor, server
timestamp, digest when conformant, and outcome. Do not store arguments,
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

## Alternative needing a ruling

Append server events to real agent-run chains instead. This requires explicit
run-context propagation across CAP/MCP, native execution, broker calls,
approval callbacks and task transitions. It must not append from two writers
to one chain. It provides a literal run boundary, but needs a different shared
transport and sequencing contract before the server writer can be implemented.

The other possible scope is a first slice restricted to explicitly task-bound
calls, omitting taskless calls. That is smaller but cannot claim to cover all
`commonly_*` traffic. The read surface must disclose that omission.

## Required evidence before enablement

1. All shared digest vectors, writer/verifier round-trip and deterministic
   OTLP bytes; editing a line breaks verification.
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
