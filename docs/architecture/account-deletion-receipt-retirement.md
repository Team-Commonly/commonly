# Account-deletion receipt retirement investigation

Status: investigation for TASK-004, 2026-10-25. No receipt retirement is
implemented or approved by this document. The deletion implementation under
review is [PR #2721](https://github.com/Team-Commonly/commonly/pull/2721), measured
at `ddb363c74b17f50d3c913b1f56587330961d4e91`. This audit branch starts from
merged main `0fc405cbedda207d5c897845381129e6c5abcac0`; it does not carry that PR.

## Two jobs currently share one record

`AccountDeletion` retains only an opaque user ID and sweep timestamps. It is
both a cleanup retry item and a durable refusal witness after the User row is
removed. Those jobs have different retirement requirements.

At the measured deletion head, `isAccountDeleting` returns true if a receipt
exists or the User has a deletion marker. It does not treat a missing User as
true. Runtime token issuance/backfill and runtime authentication consume this
predicate. Removing both User and receipt therefore removes that refusal
witness. This is a source-read finding, not a demonstrated authentication
bypass; a full missing-owner credential test is still required.

Sources at the measured head:

- [Deletion state predicate](https://github.com/Team-Commonly/commonly/blob/ddb363c74b17f50d3c913b1f56587330961d4e91/backend/services/accountDeletionState.ts)
- [Runtime issuer and backfill](https://github.com/Team-Commonly/commonly/blob/ddb363c74b17f50d3c913b1f56587330961d4e91/backend/routes/registry/tokens.ts)
- [Runtime credential refusal](https://github.com/Team-Commonly/commonly/blob/ddb363c74b17f50d3c913b1f56587330961d4e91/backend/middleware/agentRuntimeAuth.ts)

## Controlled premature-retirement probe

The two existing `retries late-upload cleanup after User deletion even if File
save fails` service cases pause an upload at ObjectStore.put, complete deletion
with HTTP 204, then finish the upload. One case fails its local byte deletion;
the other fails metadata persistence.

For this audit only, the put hook was changed to delete the receipt immediately
after deletion returned 204 and before the original put resumed. The expected
receipt assertion was changed to absent. No production code changed.

Both cases reached the post-sweep byte assertion and failed: two MediaObject
rows remained where one unrelated user's object was expected. The deleted
user's late bytes remained. The metadata-failure case had no File row to locate
them. Restoring the test file restored the reviewed tree. The unmodified cases
were previously green within the 100-case integration run at this head.

This demonstrates that a successful deletion response is not a safe retirement
boundary. The upload can already have passed its first owner check. Its later
check compensates, but compensation can fail or never run after a worker crash.
The ownership-prefixed namespace lets a retained receipt recover such bytes;
it does not prohibit a delayed put after a prefix scan.

The probe used default service fixtures, not production storage or a real cloud
driver. No bound on external request completion was established. A TTL is not a
substitute for that missing proof.

Sources:

- [Upload write and compensation](https://github.com/Team-Commonly/commonly/blob/ddb363c74b17f50d3c913b1f56587330961d4e91/backend/routes/uploads.ts)
- [Mongo put and prefix deletion](https://github.com/Team-Commonly/commonly/blob/ddb363c74b17f50d3c913b1f56587330961d4e91/backend/services/objectStore/drivers/mongoDriver.ts)
- [Existing paired service probes](https://github.com/Team-Commonly/commonly/blob/ddb363c74b17f50d3c913b1f56587330961d4e91/backend/__tests__/service/accountDeletion.test.js)

## Capacity model and its limits

The sweep selects the 100 least-recently-attempted receipts each minute and
rotates failures too. The current 101-receipt regression demonstrates that the
second batch reaches the last receipt. It does not benchmark a large database.

Under an idealized fixed queue of N receipts, successful ticks and negligible
work duration, a full revisit takes `ceil(N / 100)` minutes: 100 minutes at
10,000 receipts and 1,000 minutes at 100,000. This is a calculation from the
scheduler and selection policy, not a measured service-level latency bound.
Failures, storage latency, lease loss and new arrivals can extend it. Retaining
successful historical receipts in this queue makes retry latency grow with
lifetime deletions.

## Required next proof

Before retiring an active cleanup receipt, establish all of the following:

1. Missing/deleted-owner refusal survives receipt removal for issuance,
   backfill, embedded legacy tokens and runtime authentication, while existing
   credentials belonging to another owner remain usable.
2. Every writer capable of creating owned bytes, metadata or credentials has a
   durable registration before its first side effect. New registrations must
   atomically refuse a deletion that has begun. A process-local count or a
   time-limited lease cannot prove an old worker cannot resume.
3. A registration remains unresolved for uncertain write outcomes or failed
   compensation. A failed request or disconnected worker is not a completed
   write witness. Cleanup cannot retire ahead of these registrations.
4. A final successful cleanup follows the last possible writer. Unknown-outcome
   operations need an explicit recovery protocol, including storage-side
   completion, rather than automatic expiry.
5. Mixed-version rollout drains writers that do not register. Legacy metadata,
   late reprovision mints without issuer ledger entries, OAuth/device state and
   installed runtime projections belong in the writer census.

A possible implementation separates durable refusal state from active retry
work, and registers in-flight producers. That is a proposal to test, not an
accepted design or a claim that moving the same unbounded records to another
collection solves retention. The remaining writer census, large-queue database
measurement and producer protocol are unfinished. Receipts remain without TTL.
