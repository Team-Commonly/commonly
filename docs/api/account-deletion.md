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

The endpoint is limited to ten attempts per fifteen minutes per client address.
It refuses to remove the last human administrator.

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
- Shared messages and posts remain. PostgreSQL's author row becomes a `Deleted
  user` tombstone with no avatar so historical chat joins retain an author without
  preserving its display name. Account deletion does not scrub personal details
  a person wrote into shared message text.
- Any linked Stripe subscription is canceled before the account's billing
  linkage is removed. Cancellation failure refuses deletion rather than leaving
  an unreachable recurring charge. Stripe is an external billing boundary;
  cancellation is mocked in the service tests.

## Failures and retries

Cleanup spans MongoDB, the object store, PostgreSQL and Stripe, so it is not a
single transaction. After re-authentication and billing cancellation, a durable
`accountDeletionRequestedAt` marker prevents new uploads. Upload requests already
in flight recheck the marker after saving metadata and discard their upload if
deletion has begun or the account is gone.

An `AccountDeletion` receipt retains only the opaque user id and creation time.
The scheduler retries that identity's access revocation, chat-author redaction
and upload cleanup every minute, including
bytes in its namespace that have no `File` record. The receipt survives User
deletion: a late upload that fails its own cleanup is removed on a subsequent
sweep when storage recovers. These receipts deliberately have no TTL so a delayed
write cannot outlive its cleanup intent. They contain no profile, email or token.

Bytes are removed before their `File` metadata. A failure in the deletion
request's own storage or PG cleanup returns
`503` and retains the human row so a re-authenticated retry can finish. Already
removed objects are safe to delete again. Owned API/device credentials are
revoked during cleanup; the browser session stays available for retry until the
human row is removed. A retry after the OAuth freshness window requires another
provider sign-in. Subscription cancellation uses an account-specific idempotency
key. This does not replace provider retention policies or remove billing audit
records and backups.

Relevant errors: `CONFIRMATION_REQUIRED` (400), `PASSWORD_REQUIRED` or
`REAUTH_REQUIRED` (401), `BROWSER_SESSION_REQUIRED` (403), `LAST_ADMIN` (409).

## Verification

`backend/__tests__/service/accountDeletion.test.js` exercises real MongoDB and
PostgreSQL when run with `INTEGRATION_TEST=true`, including upload bytes and
metadata removal, retained messages and anonymized author joins, agent
identity/memory continuity, token revocation, failed-cleanup retries and an
upload that crosses deletion, including storage cleanup failure and a failed
metadata save after the human row is gone. The positive OAuth case consumes a real one-time
exchange code rather than constructing the accepted JWT claim in the fixture.
