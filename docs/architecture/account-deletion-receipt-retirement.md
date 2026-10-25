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
witness. A controlled retirement probe below confirms successful issuance;
a full authenticated-request probe is still required before calling it an
authentication bypass.

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

## Controlled delayed-issuance probe

The existing paired `revokes a token minted or backfilled after deletion
completed` cases pause a credential create/upsert while deletion returns 204.
The legacy reprovision case pauses the agent User save and has no issuer ledger.
For this audit, each hook removed the receipt after 204 and before resuming its
write. No production code changed.

All three refusal expectations failed because issuance resolved successfully.
The control implementation with its receipt retained previously passed these
cases. The test file was restored after the probe. This proves that receipt
removal changes issuer behavior, including the legacy no-ledger path. It does
not yet prove that a subsequent runtime request succeeds: installation status,
lineage and other authorization predicates must also be tested.

## Writer inventory started at the measured head

This table is a source-read inventory of the listed surfaces, not a claim that
all producers have been found. Authentication before a handler starts is not a
durable record that the handler has finished.

| Producer | Side effects to account for | Retirement proof still needed |
| --- | --- | --- |
| `routes/uploads.ts`, `ObjectStore.put` | MediaObject bytes, then File metadata | A put already authorized before deletion may finish later; compensate or retain retry intent on uncertain failure. |
| `routes/registry/tokens.ts` | AgentCredential create/backfill, agent User token array, installation token array | Current pre/post deletion refusal depends on the receipt; legacy no-ledger path is included in the failing probe. |
| `services/spawnCredentialService.ts` | Legacy seat upsert, child credential create, renewal | Parent/status lineage is distinct from proving all owner-side writes have stopped. Trace every caller and unknown outcome. |
| `services/machineService.ts`, `daemonCredentialService.ts` | Machine create and daemon credential create | The device-token path rechecks the device; browser/API registration has a different postcondition. Machine existence alone does not prove a live owner. |
| `services/deviceAuthorizationService.ts` | DeviceAuthorization decisions/consumption, atomic User token push | A non-upserting User update cannot recreate a removed User, but late DeviceAuthorization rows and the marked-User interval still need a completed-write witness. |
| `controllers/oauthController.ts` | OAuth state creation/consumption and session exchange | State TTL is not proof that all server-side callbacks finished. Trace state ownership and every callback write. |
| `services/accountDeletionService.ts` | Revocation, PG anonymization, upload cleanup and sweep timestamps | Final cleanup must follow the last writer; a clean scan alone cannot establish that ordering. |

The inventory must also cover registration/provisioning callers, legacy scripts,
metadata writers outside these routes, socket-triggered work and workers started
by old binaries. No active-operation registry is present in the audited deletion
implementation.

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
