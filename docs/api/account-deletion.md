# Self-serve account deletion

`DELETE /api/users/me` accepts a browser JWT and a JSON body:

```json
{ "confirmation": "DELETE", "password": "the current password" }
```

A successful request returns `204`. A password account must supply its current
password, including accounts that also have a linked OAuth provider. An OAuth-only
account must complete a new provider sign-in and confirm within five minutes.
Only the one-time OAuth exchange stamps `oauthAuthenticatedAt` on its signed JWT;
ordinary JWT issuance and session refresh do not supply that proof. API tokens,
device tokens and agent runtime credentials cannot call this route.

The human upload endpoint is also limited to sixty requests per fifteen minutes
per client address, ahead of authentication and multipart parsing.

The endpoint is limited to ten attempts per fifteen minutes per client address.
Administrators must hand off their role before deletion: another administrator
must first make the deleting account a member. Concurrent admin deletion
requests are refused without changing either account. The deletion marker is
conditional on the account still being a non-admin, and role updates refuse a
marked account, so a concurrent promotion and deletion cannot cross that boundary.

## Data and identity rules

- The human's MongoDB `User` row is deleted. Its embedded API/device tokens no
  longer authenticate, and browser JWT verification refuses the missing account.
  Existing browser sockets are disconnected.
- Every `File` owned by that human is removed, including legacy inline payloads.
  Its object-store bytes are deleted first, using `fileName` as the storage key.
  New uploads use the ownership namespace `user-<userId>-`, which lets deletion
  find bytes even if their metadata save failed.
  Ownership comes from `File.uploadedBy`; `MediaObject` has no ownership column.
  This includes avatars and uploads shared into pods. Other users' and agents'
  uploads remain.
- Authorized device-login and OAuth-login state rows for the human are removed.
  Owned `AgentCredential` records and their descendants are revoked; machine
  registrations are removed. Agent credentials owned by other humans remain.
- Active runtime installations made by the human are paused. Their records,
  independent agent `User` identities, memory and pod memberships survive
  (ADR-001). Installations made by other humans remain active. Legacy agent
  tokens that carry no human ownership are not reclassified as the human's token.
- The deleted human is removed from ordinary pods' `Pod.members` and PG
  `pod_members` mirror. Strict 1:1 `agent-room` and `agent-dm` pods retain both
  historical member IDs in both stores; removing one would corrupt their shape.
  The deleted account cannot authenticate, its PG author is anonymized, and its
  owned runtime installations are paused. This preserves conversation history,
  not an active human account. Pods have no separate archive lifecycle field.
  Pod reads and runtime context render a missing member as `Deleted user`;
  membership and agent-DM observer fan-out still use the historical IDs.
  Pods they created retain only the opaque historical `createdBy` reference; no
  ownership transfer occurs. Other humans' and agents' memberships remain.
- Shared messages and posts remain. PostgreSQL's author row becomes a `Deleted
  user` tombstone with no avatar so historical chat joins retain an author without
  preserving its display name. Account deletion does not scrub personal details
  a person wrote into shared message text. Attachments they uploaded are removed
  even when shared in someone else's message; retained text may have a missing attachment.
- Any linked Stripe subscription is canceled before the account's billing
  linkage is removed. Cancellation failure refuses deletion rather than leaving
  an unreachable recurring charge. Stripe is an external billing boundary;
  cancellation is mocked in the service tests.

## Failures and retries

Cleanup spans MongoDB, the object store, PostgreSQL and Stripe, so it is not a
single transaction. After re-authentication, an atomic non-admin claim sets
`accountDeletionRequestedAt` before calling Stripe. The marker blocks promotion,
new uploads and owned runtime authentication during preflight. Stripe cancellation
has a 30-second timeout and no automatic network retry. Failure releases only
that attempt's marker and preserves credentials, uploads and the human row.
A crashed preflight can be reclaimed after five minutes. A timeout can have an
unknown provider outcome; retry uses the same account-and-subscription idempotency
key. After successful preflight, the durable cleanup receipt is created. Retries
with a receipt skip billing cancellation. Upload requests already
in flight recheck the marker after saving metadata and discard their upload if
deletion has begun or the account is gone.

An `AccountDeletion` receipt retains the opaque user id, creation time and last
attempt time.
A scheduler tick runs every minute under a renewable two-minute cluster lease.
Before receipt cleanup, it recovers at most 100 stale authorized user markers
whose receipt write failed. It repeats billing preflight with the same idempotency
key before creating a receipt; it never cleans uploads before billing succeeds.
Fresh claims are excluded. Failed recovered preflights retain their marker and
rotate by claim time for another attempt. A retained human can finish deletion
through a re-authenticated browser retry after cleanup succeeds.
Each tick processes at most 100 receipts, ordered by the oldest attempt. Failed
receipts also rotate to the back of the queue. One cleanup failure does not stop
other receipts: the sweep reports their failures as an aggregate after the batch,
with opaque receipt ids in the scheduler log. Lease expiry recovers a crashed
worker; operations are idempotent if an expired worker finishes a late operation.

Each attempt retries access revocation, chat-author redaction and upload cleanup,
including bytes in its namespace that have no `File` record. The receipt survives User
deletion: a late upload that fails its own cleanup is removed on a subsequent
sweep when storage recovers. These receipts deliberately have no TTL so a delayed
write cannot outlive its cleanup intent. They contain no profile, email or token.
Processing progress stores only `lastSweptAt`. A busy queue can take multiple ticks to revisit a receipt.

Runtime-token issuance checks both the live deletion marker and the durable
receipt before mint/backfill and after its writes. A late write owned by the
deleting account is revoked from all token stores before issuance refuses. An
existing token owned by someone else is preserved. Runtime authentication also
refuses credentials whose owner has a deletion marker or receipt, covering the
interval before the issuer completes its post-write check.

Bytes are removed before their `File` metadata. A failure in the deletion
request's own storage or PG cleanup returns
`503` and retains the human row so a re-authenticated retry can finish. Already
removed objects are safe to delete again. Owned API/device credentials are
revoked during cleanup; the browser JWT is refused for ordinary HTTP, socket handshakes/packets,
attachment access and hosted connector use while the deletion marker remains.
Existing browser sockets are disconnected during access cleanup. Two canonical
HTTP routes remain: re-authenticated `DELETE /api/users/me`, and read-only
`GET /api/auth/user`, which returns only id, username, email, role and
`accountDeletionPending: true` so AuthContext can reopen Settings after reload or
fresh OAuth. This bootstrap grants no pod/profile/refresh access. Password or
fresh OAuth proof is still required on every deletion retry. A retry after the OAuth freshness window requires another
provider sign-in. Subscription cancellation uses an account-and-subscription-specific idempotency
key. This does not replace provider retention policies or remove billing audit
records and backups.

Relevant errors: `CONFIRMATION_REQUIRED` (400), `PASSWORD_REQUIRED` or
`REAUTH_REQUIRED` (401), `BROWSER_SESSION_REQUIRED` (403), `ADMIN_HANDOFF_REQUIRED` or `ACCOUNT_CHANGED` (409).

## Verification

`backend/__tests__/service/accountDeletion.test.js` exercises real MongoDB and
PostgreSQL when run with `INTEGRATION_TEST=true`, including upload bytes and
metadata removal, retained messages and anonymized author joins, agent
identity/memory continuity, token revocation, failed-cleanup retries and an
upload that crosses deletion, including storage cleanup failure and a failed
metadata save after the human row is gone. The positive OAuth case consumes a real one-time
exchange code rather than constructing the accepted JWT claim in the fixture.

## Request quotas

Deletion permits ten attempts per user per fifteen minutes; human uploads permit
sixty. These quotas run after authentication and use the durable user id, so
rotating sessions or forged forwarding headers cannot reset them. Before auth, a coarse quota keys on a SHA-256 digest of the presented bearer
(120 deletion / 6,000 upload attempts per fifteen minutes), never its plaintext.
Requests without credentials share a separate anonymous bucket. Exhausting that
bucket cannot block an authenticated account. Rotating invalid credentials can
evade this coarse bound; it does not replace ingress abuse protection. The
post-auth quota remains keyed by stable user id across valid session rotation.
No quota keys on the shared proxy socket or untrusted forwarding headers.

Lily ruled on 2026-10-25 to preserve agent identities and leave them detached.
Original ownership remains, owned runtimes pause and owned credentials are revoked.
Self-serve re-attachment requires the original owner, so it is unavailable after
that owner is deleted. No ownership transfer or administrator recovery is introduced.

## Remaining bounds

Receipts deliberately retain the opaque id after cleanup because not every late
producer is fenced. With N retained receipts, a healthy 100-per-minute sweep can
take roughly ceil(N/100) ticks per full revisit; work grows with lifetime
deletions. Retiring receipts requires a proven producer horizon, not an arbitrary
TTL. TASK-004 tracks that capacity/retirement work.

Administrator role, ban and admin-delete mutations now share the non-expiring,
majority-acknowledged lock introduced by #2742 (TASK-003). Actor authorization and
administrator recount happen inside it. Role updates also retain the atomic
`accountDeletionRequestedAt`-absent predicate: self-serve deletion claims do not
take the global lock, so the lock alone cannot prevent a late promotion of a
marked account. Tests exercise both orders through the actual handlers:
promotion wins before the deletion claim and prevents billing cancellation, or
deletion marks after the role handler reads its target and promotion returns 409.
See [the lock runbook](../runbooks/admin-user-mutation-lock.md) for uncertain-write
recovery and the mixed-version rollout constraint. Synthetic purge DM cleanup
remains a separate TASK-005 follow-up.
