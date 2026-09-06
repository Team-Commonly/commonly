# Mention attention resolution

Sam's 2026-09-06 ruling (Sharpen decision card 64261, reply 64274)
supersedes TASK-130's original broad, any-later-post rule.

An open mention resolves with `resolvedBy: 'replied'` only when a later
message by its recipient, in the same pod, either belongs to its non-null
`threadRootId` or explicitly replies to its `messageId`. An unrelated post
does not resolve it. Explicit acknowledgement remains a separate
`resolvedBy: 'acknowledged'` path. Neither path resolves another recipient's
attention or another kind of attention.

The PostgreSQL writer passes persisted reply and thread IDs, including
automatically derived roots, to the attention resolver. Unthreaded writes
skip the resolution query. Mongo fallback messages do not persist thread or
reply edges; they cannot provide this evidence and remain open unless
explicitly acknowledged.

## Legacy open mentions

`npm run sweep:resolved-mention-attention` in `backend/` defaults to a dry run.
Its PostgreSQL query uses the same later-recipient/thread-or-reply rule.
Missing or unreadable source evidence must not be interpreted as a reply.
Inspect `scanned`, `eligible`, `resolved`, and `unavailable` before considering
`--apply`. Production application requires explicit operator authorization;
the semantics ruling is not that authorization.

The script only considers open mentions. It does not reopen, relabel, or
otherwise repair items already resolved under the superseded broad rule.
Those require a separately authorized, source-backed corrective operation.
The old broad-rule eligible count is not an estimate for the narrow sweep:
rerun the dry run after the narrow implementation is deployed.

## Regression proof

`backend/__tests__/service/threading.derivation.test.js` executes the live
writer and sweep against real MongoDB and PostgreSQL. It distinguishes an
unthreaded post, a different thread, an ordinary same-thread post without a
reply edge, and a direct reply to a legacy item without a thread ID. Each
case checks the live state, dry-run nonmutation, and applied sweep outcome.
