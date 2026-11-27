# Versioned PostgreSQL changes and repository extraction

## Boot and upgrade contract

`config/init-pg-db.ts` calls `runPgMigrations` before `pgBootService` mounts PG
routes or reports readiness. A failure returns false to the existing retry loop.
Each runner checks out **one connection**, takes the session advisory lock
`(1129270605, 504)`, reads history, and runs pending files in filename order.
Competing backend boots wait for that session to unlock, then reread history.
A process exit releases its session lock through PostgreSQL.

Files live in `backend/config/migrations/NNNN_name.sql`. Four-digit versions
must be unique. Each file's SQL and its `schema_migrations` row commit in one
transaction. A failed file rolls back and can be retried. Earlier successful
files remain committed. The row stores filename, SHA-256 and application time.
Edited or removed applied files, and files inserted before applied history,
refuse boot. Add a new numbered file to correct an applied migration.

`0001_legacy_schema.sql` freezes the former boot DDL, including its existing
retrofit ALTERs. On an existing instance it runs once without discarding rows;
on a fresh instance it creates the schema. `config/schema.sql` is a compatibility
symlink to this frozen baseline for older fixtures/scripts, **not the latest
schema**. New schema tests should call the runner. `migration_records` remains
the separate application/backfill ledger (including threading cutoff details);
its rows do not determine which SQL files the runner executes.

## Adding a migration

1. Pick the next unused `NNNN_name.sql`. Coordinate numbers across open lanes.
   Add its name to `SHIPPED` in `backend/__tests__/service/pgMigrations.test.js`;
   two lanes taking the same number then conflict on that line.
2. Write SQL that upgrades a populated previous schema. A column inside
   `CREATE TABLE IF NOT EXISTS` alone never upgrades an existing table. Keep
   rolling old/new application versions compatible with additive changes.
3. Do not include BEGIN/COMMIT/ROLLBACK, change the runner's lock, or use
   commands that cannot run in a transaction (such as CREATE INDEX CONCURRENTLY).
   Large online index builds and data backfills remain separate operator jobs.
4. Test both an empty database and the previous populated shape. Verify failure
   rolls back DDL and its ledger row; rerun to prove completed SQL is skipped.
5. Run `npm --prefix backend run build`. The build copies SQL assets into
   `dist/config/migrations`; the backend Docker build uses the same command.

There is no automatic down migration. This image refuses a database whose
recorded migrations it does not carry, so rolling back an image after new SQL
ran requires a compatible image carrying that migration history. Do not delete
history to bypass this check. Take a backup before destructive migrations and
ship destructive changes only after old application versions are drained.

## Repository template: AgentPodReadCursor

Production callers import `repositories/agentPodReadCursorRepository`, never
`models/AgentPodReadCursor`. ESLint checks both imports and require calls for
this extracted model. Model tests may still seed and inspect real Mongo rows.
Since step 2 the repository is built on the dual-store helper
(`repositories/dualStore.ts`) and the cursor has a Postgres table,
`agent_pod_read_cursors` (`0016`). `STORE_MODE_AGENT_POD_READ_CURSOR` selects
the store; unset means `mongo`, which makes no Postgres call. **Mongo remains
authoritative** until step 4. Moving it, with rollback for each step:
[`docs/runbooks/adr-034-model-move.md`](../runbooks/adr-034-model-move.md).

- `getReadWatermark(agentUserId, podId)` returns a plain
  `{readAt: Date, readRevision?: number}` or null.
- `advanceReadWatermark(agentUserId, podId, watermark)` resolves after writing.
  It keeps the deterministic `agent:pod` key, independent `$max` timestamp and
  revision updates, omitted-revision behavior, and duplicate-upsert loser retry.
  Other Mongo errors propagate to the freshness gate. A Postgres error in
  `dual` or `pg-read` does not: the write stands in Mongo, flagged for repair.

## Second model: AgentFirstContact

`AgentFirstContact` (the durable record that a person and an agent have met)
follows the same template. Its table is `agent_first_contacts` (`0017`): the
Mongo `_id` as `id`, the natural key `(user_id, agent_name, instance_id)` under
a unique index, `greeted_at_by_pod` as JSONB, and a nullable `created_at`.
`STORE_MODE_AGENT_FIRST_CONTACT` selects the store. Production callers import
`repositories/agentFirstContactRepository`; ESLint fences the model as it does
the cursor.

- `claimFirstContact(identity, fields)` resolves `{ inserted }`, true only for
  the call that created the marker (a `$setOnInsert` upsert). A duplicate-key
  error from two first claims racing still propagates to the caller.
- `claimPodGreeting(identity, podId, now, expiredBefore)` resolves true only
  for the call that stamped `greetedAtByPod.<podId>` (absent, or older than
  `expiredBefore`).

Both claims run in Mongo in `mongo`, `dual` and `pg-read`. In `mongo` they call
`AgentFirstContact.findOneAndUpdate` directly, as before, without the helper. In `dual`
and `pg-read` they go through the helper's `insertIfAbsent` and `setWhere`, and only a won
claim takes a version and is copied.
`pg` mode refuses both until step 4.

## Third model: AgentDigestState

`AgentDigestState` (the per-seat count of unread ambient events folded out of
the AgentEvent retention window) follows the same template. Its table is
`agent_digest_states` (`0018`): the Mongo `_id` as `id`, the natural key
`(agent_name, instance_id, pod_id)` under a unique index, an index on
`(unread_count, unread_since)` for the wake scan, `conversations` and
`last_event_ids` as JSONB, and nullable `unread_since`, `folded_through_id`,
`created_at` and `updated_at`. `STORE_MODE_AGENT_DIGEST_STATE` selects the
store. Production callers (`services/agentDigestFoldService.ts`,
`services/schedulerService.ts`) import `repositories/agentDigestStateRepository`;
ESLint fences the model. Settling zeroes the row; nothing deletes one.

- `getFoldState(scope)` returns `{foldedThroughId, unreadCount, conversations,
  otherCount}` or null.
- `startFoldState(scope, fields)` resolves true when it created the state and
  false on a duplicate key (another worker created it first).
- `advanceFold(scope, expected, change)` resolves true only if the state was
  still at `expected` (its cursor and unread count) and took the fold step.
- `readUnreadDigest(scope)` returns the unread summary or null.
- `settleDigest(scope, revision)` clears the summary only at that revision.
- `listDueForWake(threshold)` lists the scopes unread since `threshold` or
  earlier, for the unread-digest wake.

In `mongo` every operation makes the pre-step-2 Mongoose call, without the
helper. In `dual` and `pg-read` the two conditional updates go through the
helper's `updateWhere`: the operator update rewritten as pipeline stages (`$inc`
as `$add`, the capped `$push` as `$slice` over `$concatArrays`), with the
version and marker in the same write. The three reads go through `findOneWhere`
and `findWhere`, which read Mongo in `dual` and Postgres in `pg-read` (Mongo
while anything is flagged). Their Postgres filter accepts only equality and
`$gt`/`$gte`/`$lt`/`$lte` on declared columns, bound as parameters; anything
else throws before a query, in `dual` too. `pg` mode refuses the writes until
step 4.

## Fourth model: AgentTaskWakeState

`AgentTaskWakeState` (the per-seat throttle on assigned-task wakes, keyed by
the seat) follows the same template. Its table is `agent_task_wake_states`
(`0019`): the Mongo `_id` (the seat key) as `id`, a nullable `last_wake_at`
(releasing a slot unsets it and keeps the row), and nullable `created_at` and
`updated_at`. `STORE_MODE_AGENT_TASK_WAKE_STATE` selects the store. Its only
caller, `services/assignedTaskWakeService.ts`, imports
`repositories/agentTaskWakeStateRepository`; ESLint fences the model.

- `reserveWake(key, now, intervalMs)` resolves true only for the call that took
  the seat's slot (absent, released, or last woken `intervalMs` ago or
  earlier), and false when another worker holds it.
- `releaseWake(key, now)` returns the slot only if it is still the one taken
  at `now`.

In `mongo` both make the pre-step-2 Mongoose calls; the reservation's
duplicate-key loser is answered as false. In `dual` and `pg-read` the reserve
is the helper's `updateWhere` on a stale or released slot, then
`insertIfAbsent` on an absent one: each is one atomic Mongo write from free to
held, so exactly one racing worker wins, and a held slot matches neither. The
release is `updateWhere` with `$unset`. `pg` mode refuses both until step 4.
In dual and pg-read the helper's `insertIfAbsent` sets the timestamps on the
insert only, so a reserve that finds a held slot writes nothing.

## Fifth model: NeedsYouEmailQuota

`NeedsYouEmailQuota` (the per-recipient daily cap on needs-you emails) follows
the same template. Its table is `needs_you_email_quotas` (`0020`): the Mongo
`_id` as `id`, `recipient_user_id` (hex), `day` (`YYYY-MM-DD` text, as Mongo
stores it) and `count`, with `(recipient_user_id, day)` unique as in Mongo.
`STORE_MODE_NEEDS_YOU_EMAIL_QUOTA` selects the store. Its only caller,
`services/needsYouEmailService.ts`, imports
`repositories/needsYouEmailQuotaRepository`; ESLint fences the model.

- `claimEmailSlot(recipientUserId, day, limit)` resolves true when this call
  took one of the day's `limit` slots, and false when they are all taken. The
  limit (3) stays in the service.

In `mongo` it makes the pre-step-2 Mongoose calls: the `$setOnInsert` upsert,
whose duplicate-key loser goes on, then the conditional `$inc` below the limit.
In `dual` and `pg-read` the same two writes are the helper's `insertIfAbsent`
on `(recipientUserId, day)` and `updateWhere` with `count < limit` and a
pipeline `$add`; each slot is one atomic Mongo write, so racing claims take
exactly `limit`, and a full day writes and copies nothing. `pg` mode refuses
until step 4, before any write.

## Sixth model: AgentComputerTakeover

`AgentComputerTakeover` (a person's takeover of an agent's computer, keyed by
the AgentInstallation id and owned by one user) follows the same template. Its
table is `agent_computer_takeovers` (`0021`): the Mongo `_id` (the installation
id, hex) as `id`, `owner_id` (hex, indexed), `active`, a nullable `target_id`
(the bound browser target), and nullable `created_at` and `updated_at`.
`STORE_MODE_AGENT_COMPUTER_TAKEOVER` selects the store. Its only caller,
`services/agentComputerBroker.ts` (`takeoverStore`), imports
`repositories/agentComputerTakeoverRepository`; ESLint fences the model.

- `isTakeoverActive(userId, installationId)` is true only for the owner's
  active takeover.
- `setTakeover(userId, installationId, active)` and
  `bindTarget(userId, installationId, targetId)` upsert the owner's document; a
  first bind starts inactive.
- `listBindings(userId)` returns the owner's installations with a non-empty
  string `targetId`.

Every call is keyed by `(installation, owner)`. An installation id another
user owns is never read as theirs, and a write to it fails with Mongo's
duplicate key (11000) and changes neither store, in every mode.

In `mongo` the four make the pre-step-2 Mongoose calls. In `dual` and
`pg-read` a write is the helper's `updateWhere` on `{ _id, ownerId }`; on a
miss, `insertIfAbsent` with the same filter; and when that finds a document a
racing first call inserted, `updateWhere` once more, so the last writer's value
stands. The reads are `findOneWhere` and `findWhere` on `_id`, `ownerId` and
`active`; `listBindings` filters a missing `targetId` in code, since the
Postgres filter has no `$exists`. `pg` mode refuses the writes until step 4,
before any write.

## Seventh model: BillingEvent

`BillingEvent` (the Stripe webhook idempotency marker) follows the same
template. Its table is `billing_events` (`0022`): the Mongo `_id` (hex) as
`id`, `event_id` (unique, as in Mongo), `type`, nullable `customer_id` and
`user_id` (hex), `outcome`, a nullable `detail`, and a nullable `created_at`
(the model has no `updatedAt`). `STORE_MODE_BILLING_EVENT` selects the store.
Its only caller, `services/billingService.ts` (`handleEvent`), imports
`repositories/billingEventRepository`; ESLint fences the model.

- `claimBillingEvent(eventId, type)` takes the lock: true when this call
  claimed the event, false when it was already claimed (a duplicate delivery,
  which `handleEvent` returns as `{ outcome: 'duplicate' }`).
- `recordBillingOutcome(eventId, fields)` sets the outcome. A field whose value
  is `undefined` writes nothing, so an absent `customerId` never becomes null.

In `mongo` both make the pre-step-2 Mongoose calls (`create`, and `updateOne`
with the fields as passed). In `dual` and `pg-read` the claim is the helper's
`create`: Mongo's duplicate key propagates before any copy and reads as
`false`, and a copy that fails after the insert still returns `true`, with the
marker left for `repair`. So a Postgres error never loses or doubles a claim.
The record is `updateWhere({ eventId })` with the defined fields as
`$literal`s and `userId` cast to an ObjectId. `pg` mode refuses both until
step 4, before any write.

## Eighth model: DiscordSummaryHistory

`DiscordSummaryHistory` (one row per Discord summary queued for Commonly Bot)
follows the same template; the seventh, `BillingEvent`, takes `0022`. Its
table is `discord_summary_histories` (`0023`): the Mongo `_id` (hex) as `id`,
`integration_id` (hex), `summary_type`, `content`, `message_count`, the
embedded `timeRange` as a JSONB `time_range` of ISO strings, the nullable
`posted_to_discord` and `posted_to_commonly`, and the nullable `created_at` and
`updated_at`. Indexes mirror Mongo's `{ integrationId, createdAt }` and
`summaryType`; Mongo's index on the whole `timeRange` subdocument has no
counterpart, and nothing reads the model at all.
`STORE_MODE_DISCORD_SUMMARY_HISTORY` selects the store. Its two writers,
`services/discordService.ts` (`syncRecentMessages`) and
`services/schedulerService.ts` (`summarizeIntegrationBuffers`), call
`recordDiscordSummary(fields)` from `repositories/discordSummaryHistoryRepository`;
ESLint fences the model.

The model is insert-only. In `mongo` the write is the pre-step-2
`new DiscordSummaryHistory(fields).save()`, with no Postgres call. In `dual`
and `pg-read` it is the helper's `create`, which is `Model.create` (so the same
validation, defaults and timestamps) with the version and the marker; a copy
that fails after the insert still resolves, with the marker left for `repair`.
`pg` refuses before any write until step 4.

## Ninth model: NeedsYouEmail

`NeedsYouEmail` (one needs-you email per attention item) follows the same
template. Its table is `needs_you_emails` (`0024`): the Mongo `_id` (hex) as
`id`, `attention_item_id` (unique, as in Mongo), `recipient_user_id`
(indexed), `click_token` (unique), `status`, nullable `sent_at`, `clicked_at`
and `included_in_digest_at`, and nullable `created_at` and `updated_at`.
`STORE_MODE_NEEDS_YOU_EMAIL` selects the store. Its callers,
`services/needsYouEmailService.ts` and `services/digestEmailService.ts`,
import `repositories/needsYouEmailRepository`; ESLint fences the model.
`0024` must be applied after `0023`, never before it (the runner matches
history by position).

- `claimNeedsYouEmail` claims an item: the claim's id, or null when the item
  was already claimed. `setNeedsYouEmailStatus` sets `overflow`, `sent` (with
  `sentAt`) or `failed`.
- `findNeedsYouClick(token)` and `markNeedsYouClicked(id)` serve the email
  link; only the first click stamps `clickedAt`.
- `listUndigestedOverflow(userId)` and `markIncludedInDigest(ids, at)` serve
  the daily digest.

In `mongo` each makes its pre-step-2 Mongoose call. In `dual` and `pg-read`
the claim is the helper's `create` (a copy that fails after the insert still
claims), status changes are `update`, the click stamp is `updateWhere` on
`clickedAt: { $exists: false }`, and the digest mark is `updateManyWhere`.
`clickedAt` and `includedInDigestAt` are declared presence columns, since
their writers never store null, so `$exists` on them runs on Postgres too.
`clickToken` is `select: false`: the helper names it in every read it copies
from and drops it from what it returns, and each read here names its
fields, so a Postgres read never returns the token where Mongo wouldn't.
The click lookup reads Mongo in every mode but `pg`. `pg` mode refuses the
writes until step 4, before any write.

## Tenth model: AgentTaskRowWakeState

`AgentTaskRowWakeState` (what the assigned-task wake remembers about one row
for one seat, keyed `<seat key>|<row _id>`) follows the same template. Its
table is `agent_task_row_wake_states` (`0025`): the Mongo `_id` as `id`, a
nullable `last_wake_at`, `last_wake_event_id` and `counted_event_id` (AgentEvent
ObjectIds as hex text, read back as ObjectIds), `failures`, `stopped_at`,
`last_verdict`, and nullable `created_at` and `updated_at`.
`STORE_MODE_AGENT_TASK_ROW_WAKE_STATE` selects the store. Its only caller,
`services/assignedTaskWakeService.ts`, imports
`repositories/agentTaskRowWakeStateRepository`; ESLint fences the model.
`0025` must be applied after `0024`, never before it.

- `findRowWakeStates(keys)` reads the states that exist, in the lean shape.
- `countRowOutcome`, `stopRowWake`, `unstopRowWake` and `resetRowWake` are the
  conditional changes; each answers true exactly when Mongo's `modifiedCount`
  was 1 (every one sets a value its filter excludes).
- `recordRowWakes(keys, stamp)` stamps the shown rows before a wake is queued,
  and `clearRowWakeStamps(keys, now)` takes back the stamp from rows a failed
  record reached.

In `mongo` each makes its pre-step-2 Mongoose call (the ordered `bulkWrite`
included). In `dual` and `pg-read` the read is `findWhere` with `$in`, the
changes are `updateWhere`, the record is one helper `upsert` per row in order
(stopping at the first failure, as the ordered bulkWrite does; a first write
gets the schema defaults, `createdAt` and `__v`), and the compensation is
`updateManyWhere`. A Postgres copy that fails never fails the record; its
marker is left for `repair`. `pg` refuses the writes until step 4, the record
before any write.

## Eleventh model: AgentProviderKey

`AgentProviderKey` (the binding of an agent's own model-provider key to its
owner and destination) follows the same template. Its table is
`agent_provider_keys` (`0026`): the Mongo `_id` as `id`, `agent_user_id`
(unique, as Mongo's index is), `owner_user_id` and `set_by` (User ObjectIds as
hex text, read back as ObjectIds), `provider_id`, `base_url`, `generation`,
`secret_ref`, nullable `set_at` and `last_used_at`, and nullable `created_at`
and `updated_at`. `secret_ref` is the id of the `ConnectorSecret` that holds
the key encrypted, never the key. `STORE_MODE_AGENT_PROVIDER_KEY` selects the
store. Its callers, `services/agentProviderKey.ts` and the orphaned-secret
sweep in `services/installable/installableReconciler.ts`, import
`repositories/agentProviderKeyRepository`; ESLint fences the model. `0026`
must be applied after `0025`, never before it.

- `findProviderKey(owner)` reads the binding (owner GET, machine launch).
- `findProviderKeyBySecretRef(ref)` tells the sweep whether a binding still
  names a secret; it reads Mongo in every mode but `pg`.
- `bumpProviderKeyGeneration` and `commitProviderKey` are a set's two steps:
  the `$inc` upsert whose generation is the lock, then the `$set` only at that
  generation.
- `clearProviderKey` is the remove, returning the pre-image that names the
  secret to delete.
- `markProviderKeyUsed(row, at)` stamps a launch only while the binding still
  has the read's secret and generation.

In `mongo` each makes its pre-step-2 Mongoose call. In `dual` and `pg-read`
the owner read is `findOneWhere`, a launch's and the sweep's are `findPageMongo`
(so neither decides on a lagging Postgres row), the set, commit and remove are `findOneAndUpdateWhere` (decided on Mongo, the whole
document copied, so an `$inc` lands in Postgres as Mongo computed it), and the
stamp is `setWhere`. `pg` refuses the writes until step 4, before any write.

## Twelfth model: HostedMcpDcrRegistration

`HostedMcpDcrRegistration` (the instance's OAuth Dynamic Client Registration
client per hosted-MCP catalogue entry) follows the same template. Its table is
`hosted_mcp_dcr_registrations` (`0027`): the Mongo `_id` as `id`, `entry_id`,
`issuer`, `client_id`, `redirect_uri`, `token_endpoint_auth_method`,
`client_secret_ref`, `client_secret_expires_at`, `current` (boolean), nullable
`retired_at`, `refused_at` and `asked_at`, and nullable `created_at` and
`updated_at`. Its two unique indexes are Mongo's: `(entry_id, issuer) WHERE
current` and `(entry_id, issuer, client_id)`. Neither store has a TTL.
`client_secret_ref` is the id of the `ConnectorSecret` that holds a
confidential client's secret encrypted, never the secret.
`STORE_MODE_HOSTED_MCP_DCR_REGISTRATION` selects the store. Its callers,
`services/hostedMcpDcrRegistry.ts`, the orphaned-secret sweep in
`services/installable/installableReconciler.ts` and
`scripts/retire-hosted-mcp-dcr-client.ts`, import
`repositories/hostedMcpDcrRegistrationRepository`; ESLint fences the model.
`0027` must be applied after `0026`, never before it.

- `findCurrentDcrRegistration(entry)` and `findUsableDcrRegistration(entry,
  clientId)` read the client a start may reuse and the one a row may use.
- `findDcrRegistrationSecretOwner(id)` tells the sweep whether a registration
  still owns a secret; `listCurrentDcrRegistrations()` is the script's list.
- `claimCurrentDcrRegistration(entry, fields)` is the first-start claim, one
  winner by the partial unique index.
- `retireDcrRegistrationById` and `retireCurrentDcrRegistration` stop a client
  serving new starts.
- `refuseDcrRegistration` marks a client the vendor refused, returning the
  pre-image to exactly one caller; `claimDcrAsk` takes the once-an-interval
  right to ask the vendor about a client.

In `mongo` each makes its pre-step-2 Mongoose call (hydrated documents
included). In `dual` and `pg-read` every read is `findPageMongo` (each one feeds
a security decision, so none reads a possibly lagging Postgres row), the claim,
refusal and ask are `findOneAndUpdateWhere` (decided on Mongo), and the retires
are `setWhere`. `pg` reads Postgres and refuses the writes until step 4, before
any write.

## Thirteenth model: WaitlistRequest

`WaitlistRequest` (a person's request to join the instance, and the admin's
answer) follows the same template. Its table is `waitlist_requests` (`0028`):
the Mongo `_id` as `id`, `email`, `name`, `organization`, `use_case` and `note`
(the form's personal data, as Mongo holds it), `status`, `invitation_code` (the
`InvitationCode` id as hex, never the code), `invited_by` (the admin's User id
as hex), nullable `invited_at` and `invitation_sent_at`, and nullable
`created_at` and `updated_at`. Mongo has no unique index besides `_id` and no
TTL, so neither has Postgres; `(email, status)` and `created_at DESC` are plain
indexes. `STORE_MODE_WAITLIST_REQUEST` selects the store. Its callers,
`controllers/authController.ts` (the public request) and
`routes/admin/users.ts` (the admin list, status change and send-invitation),
import `repositories/waitlistRequestRepository`; ESLint fences the model.
`0028` must be applied after `0027`, never before it.

- `findPendingWaitlistRequest(email)` and `createWaitlistRequest(fields)` are
  the public request's duplicate check and create.
- `listWaitlistRequests({ q, status, skip, limit })` is the admin list, refs
  populated by the repository.
- `setWaitlistRequestStatus(id, update)` is the admin's status change; a close
  nulls the invitation fields.
- `findWaitlistRequestForInvitation(id)`, `markWaitlistRequestInvited(request,
  fields)` and `findWaitlistRequestPopulated(id)` are send-invitation's read,
  record and response re-read; `assertWaitlistWritable` refuses the route in
  `pg` before it creates a code or sends an email.

In `mongo` each makes its pre-step-2 Mongoose call (hydrated documents and
`save()` included). In `dual` and `pg-read` the create is the helper's
`create`, the status change and the invitation are `update` (decided on Mongo,
nulls stored in both stores), the list is `findPageMongo` and `countMongo`, the
duplicate check and the invitation's read are `findPageMongo` (each decides a
write), and the response re-read is `findById`. `pg` refuses the writes and the
list until step 4, before any write.

## Postgres-only table: hand_backs

`hand_backs` (`0029`, ADR-037 Phase 1) is new state, so it has no Mongo
model, no store mode and no dual-write phase (ADR-034 D4). Mongo keeps only
the two `DecisionRequest` cards a record drives. The columns:

- `id`, a server-made UUID;
- `pod_id`, `thread_root_id`, `task_id`;
- the author: `author_agent_user_id`, `agent_name`, `instance_id`;
- the agent's two owner sources, each null when it isn't a person:
  `owner_installed_by`, `owner_user_id`;
- JSONB `asked`, carrying the server-derived requester and its provenance;
- `reviewer_user_id`;
- JSONB `plan`, `plan_decision_id` and JSONB `plan_ruling`;
- JSONB `next`;
- the three JSONB result fields: `changed`, `checked`, `unverified`;
- `handback_decision_id` and JSONB `handback_ruling`;
- `supersedes`, `status` and JSONB `withdrawn_by`;
- timestamps `created_at`, `updated_at`, `plan_ruled_at`, `handed_back_at`,
  `ruled_at` and `withdrawn_at`;
- `received_enqueued_at`, set once after `handback.received` is queued.

Indexes: `(pod_id, created_at DESC)` and `(status)`.

Only `repositories/handBackRepository.ts` reads and writes it, and every state
change there is a compare-and-set on `status`. Card ids attach with
`… decision_id IS NULL` whatever the status. `received_enqueued_at` is set
with `WHERE received_enqueued_at IS NULL`. `0029` must be applied after
`0028`, never before it.

## Message actor columns (0030)

`0030_message_actor.sql` adds two nullable `VARCHAR(24)` columns to
`messages`. They hold the people an agent's message is accountable to:

- `owner_user_id`: whose agent posted it. This is the
  `services/agentOwnerService.ts` rule: the installer of its installation in
  this pod, else the identity's `ownerUserId`, and people only.
- `on_behalf_of_user_id`: the person whose message started the run, taken
  from the run's trigger only. That is the author of the wake message a
  native run claimed (`answeringMessageId`, set by the runtime), when a person
  wrote it in this pod. A reply edge never sets it: the agent chooses what it
  replies to.

Both use the grant record's vocabulary (ADR-033 `actor.owner` and
`actor.onBehalfOf`). A run that no person started (a heartbeat, a schedule,
another agent) stores no on-behalf-of. A person's own message, a kernel line
and every older row store NULL in both. An official agent's message still
stores its owner (whoever installed it), although the UI names nobody for it.

`services/messageActorService.ts` sets them. These post paths record them:

- `AgentMessageService.postMessage` writing to PostgreSQL: native runs and
  the agent runtime routes (`/api/agents/runtime`, which CAP, MCP, webhook
  and BYO agents post through);
- a bot account posting with a user token (`req.botCaller`) through
  `POST /api/messages/:podId` or `POST /api/pg/messages/:podId`: owner only.

These do not, by design: a decision ruling reply (only a person may rule),
a chat-relay inbound message (the linked person's own), a system action line
(the platform's), the legacy Mongo copy, and the Mongo-only fallback with no
PostgreSQL. **External runtimes record no on-behalf-of yet**: their post
carries no trigger the server knows, so they store the owner only. Deriving
it from the server's record of the event that woke an external agent is a
follow-up.

They are person ids, so `models/pg/Message.ts` strips them from every row it
returns (`withoutActor`). No read path sends them.

**Rollback across 0030.** An image without this file fails boot on the extra
`schema_migrations` row (`PostgreSQL migration history mismatch`). It keeps PG
routes unavailable (503) until the row is removed. Its `RETURNING *` would
also hand the two columns to clients. So before rolling back to the previous
image, run against its database:

```sql
ALTER TABLE messages DROP COLUMN IF EXISTS on_behalf_of_user_id;
ALTER TABLE messages DROP COLUMN IF EXISTS owner_user_id;
DELETE FROM schema_migrations WHERE version = '0030_message_actor.sql';
```

Rolling forward again re-applies 0030 from scratch. The stored actors are
lost, and nothing reads them yet.

For the next aggregate, expose its domain operations, keep Mongoose queries
inside its repository, and return plain values. Do not expose `find`, `save`,
`populate`, or a generic query builder. Extract without changing storage first,
then compare existing service behavior against a real database. A later storage
switch belongs inside that module and needs its own authority/partial-write
contract before dual writes begin.

## Verification

The pg-mem suite executes ordering, retrofit, history and repeat-boot checks.
Its advisory functions are stubs; it **does not establish lock or transaction
semantics**. The service suite uses an isolated schema on real PostgreSQL for
fresh/legacy baseline, DDL rollback/retry, and two competing boot sessions.
The completion-row failure case is essential: PostgreSQL can roll back a
multi-statement SQL query even without an explicit BEGIN. Failing only inside
that query would not prove the SQL and the separate ledger INSERT are atomic.
The Mongo repository suite round-trips rows and races concurrent first reads.

```sh
cd backend
npx jest --runInBand --runTestsByPath \
  __tests__/unit/config/run-pg-migrations.test.js \
  __tests__/unit/repositories/agentPodReadCursorRepository.test.js
INTEGRATION_TEST=true PG_HOST=localhost PG_PORT=5432 \
  PG_DATABASE=commonly-test PG_USER=postgres PG_PASSWORD=postgres \
  npx jest --runInBand --runTestsByPath __tests__/service/pgMigrations.test.js
```

The real test role needs CREATE SCHEMA in a test database. Each case creates
and drops its own schema; it never drops the database or truncates other schemas.
