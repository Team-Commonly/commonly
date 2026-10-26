# Task-bound connector grants (TASK-288)

Status: implementation draft. Not cleared for merge or release. Lifecycle records
still depend on the shared `seats.record` writer owned by TASK-513. This document
is not a second record specification: names follow
`packages/seats/docs/record-v1.md` (on main via #2739) and ADR-033 §5.1.

## Authority

A grant may carry `binding: { taskId, podId, endsOn }`. Task numbers are local to
a pod; resolve both fields. `endsOn` is stored as `task.done`, the only value v1
accepts: record-v1 also defines `expiresAt`, but a grant that outlives its task's
close contradicts this task's requirement, so mint refuses it with
`invalid_task_binding` until someone needs that mode. Mint requires an existing, unfinished task in the target
pod. For seat targets, both the issuer and seat must have access to the task pod.
An unbound parent can be narrowed to a task. A bound child cannot remove or
change the binding. The parent's expiry remains a ceiling.

Use requires (ruled by the CTO for v1, 2026-10-25) the authenticated caller to be in the grant audience and the task
pod, and to hold the bound task's unexpired claim. A task selector supplied by
the model conveys no authority. The board claim route stores `claimedByUserId`
from authentication separately from its historical display key, `claimedBy`.
Legacy claims containing a User ID remain recognizable. Name-only renewal stays
compatible with the board but does not acquire grant authority: release and
claim again, or claim after expiry. Legacy provenance-based restoration also
carries no authenticated grant authority.

The shared grant guard enforces this in tool listing, normal calls, approved
call replay and hosted/daemon projection. Holding a claim is the server's v1
work-context boundary; it does not attest to the semantic purpose of arguments
or distinguish two concurrent runs of the same agent. A per-run context would
require an authenticated run credential and is not asserted by this change.

## Close and reopen

Every successful board transition to `done` increments `Task.grantEpoch` in the
same write. A bound grant stores the task's epoch at issue. Each use checks the
current epoch. Reopening never resets it, so a missed revocation write cannot
revive an old grant. Mint checks the epoch again after inserting the grant to
cover an insertion racing close.

The close hook marks bound grants and their bound descendants revoked with
`revocationReason: task.done`, the record-v1 reason (the verifier rejects
`task.closed`). It is awaited by the complete route, status
PATCH, GitHub merge completion and onboarding completion. There is no poller.
The hook only revokes grants from epochs before that close, preserving a new,
explicitly issued grant after a subsequent reopen. Unbound grants are unchanged.
Task deletion denies use because the referenced tuple no longer resolves.

A call already executing at the provider is not canceled by task closure.
Approved calls that have not begun execution must recheck authority before
provider dispatch.

## Record dependency and acceptance

The single record contract is `packages/seats/docs/record-v1.md` and ADR-033
(#2691). The spec is on main; the server writer (TASK-513) is not. This change
stores what that writer needs (the binding with `endsOn`, `taskEpoch`,
`revokedAt` and `revocationReason`) but does not emit `grant.issued` or
`grant.revoked` itself; that is an incomplete requirement and blocks clearance.

Once TASK-513 supplies the writer, issuance must carry the binding and close
must emit `task.done` then `grant.revoked {grantIds, reason: task.done}` (ADR-033
§4), using the canonical envelope.
No credential values or raw tool arguments enter those records. Failed record
emission must not undo enforcement. A non-author must walk issuance, allowed use,
closure, refused replay and the exported records before public activation.

Tests cover authenticated ownership, missing/closed/foreign tasks, lease expiry,
grant expiry, attenuation, close/reopen, mint/close races, all four completion
writers, unbound compatibility and provider refusal before dispatch. Run the
focused backend suites named in the PR evidence; browser captures are not an
acceptance instrument for this auth-only change.
