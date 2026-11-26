# Moving one model to Postgres (ADR-034 steps 2 and 3)

[ADR-034](../adr/ADR-034-postgres-single-store.md) D3 moves each Mongo model in four steps. This is the
operator procedure for steps 2 (dual) and 3 (read cut) of **one** model, run on staging first and then on
production. Step 4 (Postgres only, then dropping the Mongo code) is held until after 2026-11-30 and is not
covered here.

**Before you start, the model must already have:** step 1 done (callers go through its repository); the
repository built on `createDualStore` (`backend/repositories/dualStore.ts`); `dualStorePlugin` on its
schema; its table in a numbered migration that has run; and an entry in
`backend/repositories/dualStoreRegistry.ts`. The first model done this way is `AgentPodReadCursor`
(table `agent_pod_read_cursors`, migration `0016`). The second is `AgentFirstContact` (table
`agent_first_contacts`, migration `0017`, `STORE_MODE_AGENT_FIRST_CONTACT`), whose two atomic claims use
the helper's `insertIfAbsent` and `setWhere`. The third is `AgentDigestState` (table
`agent_digest_states`, migration `0018`, `STORE_MODE_AGENT_DIGEST_STATE`), whose fold and settle use the
helper's `updateWhere` and whose reads by filter use `findOneWhere` and `findWhere`. The fourth is
`AgentTaskWakeState` (table `agent_task_wake_states`, migration `0019`, `STORE_MODE_AGENT_TASK_WAKE_STATE`),
the per-seat assigned-task wake throttle, whose reservation uses `updateWhere` then `insertIfAbsent` and
whose release uses `updateWhere`. The fifth is `NeedsYouEmailQuota` (table `needs_you_email_quotas`,
migration `0020`, `STORE_MODE_NEEDS_YOU_EMAIL_QUOTA`), the per-recipient daily cap on needs-you emails,
whose claim uses `insertIfAbsent` then `updateWhere`. The sixth is `AgentComputerTakeover` (table
`agent_computer_takeovers`, migration `0021`, `STORE_MODE_AGENT_COMPUTER_TAKEOVER`), a person's takeover
of an agent's computer and its bound browser target, whose owner-keyed writes use `updateWhere`, then
`insertIfAbsent`, then `updateWhere` again after a lost first-write race, and whose reads use
`findOneWhere` and `findWhere`. The seventh is `BillingEvent` (table `billing_events`, migration `0022`,
`STORE_MODE_BILLING_EVENT`), the Stripe webhook idempotency marker, whose claim uses the helper's `create`
(a duplicate key means the event was already claimed) and whose outcome record uses `updateWhere`.
The eighth is `DiscordSummaryHistory` (table
`discord_summary_histories`, migration `0023`, `STORE_MODE_DISCORD_SUMMARY_HISTORY`), the record of each
Discord summary queued for Commonly Bot, which is insert-only and uses the helper's `create`.
The ninth is `NeedsYouEmail` (table `needs_you_emails`, migration `0024`, `STORE_MODE_NEEDS_YOU_EMAIL`),
one needs-you email per attention item, whose claim uses the helper's `create` (a duplicate key on
`attentionItemId` means the item was already claimed), whose status changes use `update`, whose first-click
stamp uses `updateWhere` on `clickedAt: { $exists: false }`, whose digest mark uses `updateManyWhere`, and
whose overflow read uses `findWhere` with `$exists` on its two presence columns. Its `clickToken` is
`select: false`: the helper copies it and never hands it back unless a read names it.

**Migration order: `0024` must not be applied before `0023`.** The migration runner matches history to the
sorted file list by position, so an instance that has run `0024` refuses to boot once a `0023` file appears.
`0023` (`DiscordSummaryHistory`) is on main, so `0024` follows it.

**A model whose callers delete does not enter dual yet.** A completed delete removes the document and its
row, and the version with them, so a recreated id starts again at version 1 and a late copy, a pg-mode
compare-and-set or a backfill of the old document can land on it. The prerequisite is deletes as tombstones
in both stores that keep the version. Until then the helper's `remove` throws outside `mongo` unless the
store was created with `allowDeletes: true`, which is unsafe for exactly that reason.
None of `AgentPodReadCursor`, `AgentFirstContact`, `AgentDigestState`, `AgentTaskWakeState`,
`NeedsYouEmailQuota`, `AgentComputerTakeover`, `BillingEvent`, `DiscordSummaryHistory` and
`NeedsYouEmail` has a delete path (and `NeedsYouEmail` has no TTL index).

The mode variable is `STORE_MODE_` plus the model name in upper snake case:
`AgentPodReadCursor` reads `STORE_MODE_AGENT_POD_READ_CURSOR`. Unset means `mongo`, which makes no
Postgres call at all.

The backfill script runs as its own process with the backend's environment (`MONGO_URI`, the `PG_*`
settings, and the model's `STORE_MODE_*` at the value the replicas have). Run it from a one-off container,
never inside a serving backend.

```sh
node dist/scripts/dual-store-backfill.js --model AgentPodReadCursor            # dry run, the default
node dist/scripts/dual-store-backfill.js --model AgentPodReadCursor --apply
node dist/scripts/dual-store-backfill.js --model AgentPodReadCursor --verify    # exits 1 on any difference
```

It prints counts and checksums only. Each row that differs is logged by a hashed id, never the raw id or a
value.

## The procedure

| # | Do | Done when | Roll back |
|---|---|---|---|
| 1 | **Back up** the model's Mongo collection (`mongodump --collection`) and the Postgres table (`pg_dump -t`). | Both dumps restore on a scratch server. | Nothing to undo. |
| 2 | **Set `STORE_MODE_<MODEL>=dual` on every replica**, and restart them. | Every replica is up on the new setting. | Set it back to `mongo` (or unset) and restart. Mongo has every write. Then `TRUNCATE` the table before trying dual again (see below). |
| 3 | **Backfill.** First `TRUNCATE` the table. Then run a dry run, `--apply`, and `--verify`. | `--verify` exits 0: `missing`, `differs` and `extra` are 0, and the two checksums match. | The table is only a copy. `TRUNCATE` it, or go back to mongo as in row 2. |
| 4 | **Watch** the compare and the repair job for as long as the model's writes need to cover their real paths: `[dual-store] mismatch model=<Model>` lines from the sampled compare and failed copies, and `[dual-store] repair model=<Model>` lines from the five-minute repair job. Run `--verify` again at the end. | Every mismatch is explained, and the repair job has nothing left to copy. | As in row 2. |
| 5 | **Read cut:** set `STORE_MODE_<MODEL>=pg-read` on every replica and restart, only after zero unexplained mismatches and a clean `--verify`. ADR-034 D3 also asks for the `commonly verify` scenarios to pass. | Reads come from Postgres. Measure p95 on the model's hot paths. | Set it back to `dual` and restart. Writes never stopped going to Mongo first, so no acknowledged write is lost. |

### Why dual goes on everywhere before the backfill, and why the TRUNCATE

The copy is safe against concurrent writes because of versions. In dual, every write bumps the document's
`pgVersion` and copies the row at that version, and Postgres keeps only the highest version it has seen. The
backfill copies each document at its own `pgVersion` (0 for one that has never had a dual write), so a dual
write always wins, whichever lands first.

A replica still in `mongo` breaks that. It changes the document without bumping `pgVersion` and without
touching Postgres, so the row goes stale at a version no later copy can replace. That happens in two
situations:

- during the rolling restart in row 2, when some replicas are on dual and some are still on mongo;
- after a rollback to mongo.

So the backfill runs only once every replica is on dual, and it starts with a `TRUNCATE`. That clears any
row written during the mixed window. A dual write that lands between the `TRUNCATE` and the backfill copies
itself, and the backfill copies everything else. The backfill refuses to run unless the model's mode is
`dual` or `pg-read` in its own environment.

### What the counts mean

- **Backfill:** `scanned` counts the live documents. `inserted` is what was copied, or what a dry run would
  copy. `alreadyCurrent` means Postgres already held that version or a newer one. `deferredPending` counts
  documents that carried a pending marker when scanned. They are copied in a final pass at their current
  version, pending or not, and that copy's outcome is counted in `inserted` or `alreadyCurrent`.
- **Verify:** `mongo` and `pg` are the row counts on each side. `missing` is a live document with no row,
  `differs` is a row whose fields differ (normalised the same way as the sampled compare) or whose version
  is not the document's (`fields=pgVersion`), and `extra` is a row with no live document. A document marked
  deleted counts as absent. `--verify` runs only in dual or pg-read.

**A `differs` or `missing` on a live system can be a write in flight**, caught between its Mongo commit and
its copy. Run `--verify` again; only a difference that stays across runs needs explaining. The backfill
itself re-reads every document that was pending when scanned and copies it at its current version, so a write
whose copy landed before the `TRUNCATE` is not left without a row, whenever its marker clears.

**Rolling back to mongo leaves markers behind**: `pgVersion`, a `pgPending` that is never cleared, and
`pgDeleted` documents from deletes that had not finished. They are harmless. Every mongo-mode read and write
treats a `pgDeleted` document as absent, and a write onto one starts from an empty document. Going back to
dual, the repair job finishes the flagged ones.

A failed Postgres write never fails the caller. It leaves the document flagged (`pgPending`), and the
repair job copies it on its next pass. While any document of the model is flagged, `pg-read` reads Mongo,
including after a restart. **The exception is a Mongo outage:** that flag check is a Mongo query, and when
it fails, `pg-read` reads the Postgres row rather than fail the read, logging
`[dual-store] flag check failed`. That row can predate a pending write, so reads may be stale until Mongo is
back. **The flag check is also cached per replica for 5 seconds,** with two consequences. A replica
that cached "nothing flagged" can serve a stale Postgres row for up to 5 seconds after another replica
leaves a write pending, even while Mongo is up. A replica that cached "flagged" keeps reading Mongo for
up to 5 seconds, so during an outage those reads fail until the cache expires and the failed check
falls back to Postgres. A `pg-ahead` mismatch means Postgres holds a version Mongo never wrote, which
only a rollback from `pg` can produce. That case is out of scope until step 4 is lifted.

## Before step 4 (held until after 2026-11-30)

- **`AgentPodReadCursor` needs a single-statement upsert in pg mode.** The helper's pg-mode `upsert` is
  optimistic: it reads, merges, and writes at the version it read, retrying 5 times. More than 5 writers
  racing on one id can exhaust the retries and fail the write (the unit suite shows 20 do). Before this model
  runs in `pg`, its write becomes one `INSERT … ON CONFLICT (id) DO UPDATE SET read_at = GREATEST(…),
  read_revision = GREATEST(…)`, tested on real Postgres with the same race.
- **`AgentFirstContact` cannot run in `pg` yet.** Its two claims go through the helper's `insertIfAbsent`
  (a `$setOnInsert` upsert on the unique `(userId, agentName, instanceId)`) and `setWhere` (a conditional
  `$set` of `greetedAtByPod.<podId>`), and both throw `not supported in pg mode until step 4` in `pg`.
  Before this model runs in `pg`, each needs a single-statement Postgres form with the same won/lost answer:
  `INSERT … ON CONFLICT (user_id, agent_name, instance_id) DO NOTHING RETURNING id` for the first, and
  `UPDATE … SET greeted_at_by_pod = jsonb_set(…) WHERE … AND (greeted_at_by_pod->>$pod IS NULL OR
  (greeted_at_by_pod->>$pod)::timestamptz < $expiredBefore) RETURNING id` for the second, both bumping
  `pg_version`, and both tested on real Postgres with concurrent claims.
- **`AgentDigestState` cannot run in `pg` yet.** Its first fold (`startFoldState`, a create that loses on the
  unique `(agentName, instanceId, podId)`) refuses in `pg`, and its fold step and settle go through the
  helper's `updateWhere`, which throws `not supported in pg mode until step 4`. Before this model runs in `pg`,
  each needs a single-statement Postgres form with the same answer, all bumping `pg_version` and tested on
  real Postgres with concurrent folds:
  - the first fold: `INSERT … ON CONFLICT (agent_name, instance_id, pod_id) DO NOTHING RETURNING id`;
  - a fold step: `UPDATE … WHERE <scope> AND folded_through_id IS NOT DISTINCT FROM $cursor AND unread_count =
    $expected RETURNING id`, incrementing `unread_count` and `revision` and appending to `last_event_ids`
    under its cap;
  - the settle: `UPDATE … WHERE <scope> AND revision = $revision RETURNING id`, clearing `unread_count`,
    `last_event_ids`, `conversations`, `other_count` and `unread_since`, and incrementing `revision`.

  Its reads by filter already run on Postgres in `pg-read`.
- **`AgentTaskWakeState` cannot run in `pg` yet.** `reserveWake` and `releaseWake` go through the helper's
  `updateWhere` (and `insertIfAbsent` for a seat's first wake), which throw `not supported in pg mode until
  step 4`. Before this model runs in `pg`, each needs a single-statement Postgres form with the same answer,
  bumping `pg_version` and tested on real Postgres with racing workers on an absent, a stale and a fresh key:
  - the reserve: `INSERT … ON CONFLICT (id) DO UPDATE SET last_wake_at = $now WHERE
    agent_task_wake_states.last_wake_at IS NULL OR agent_task_wake_states.last_wake_at <= $now - interval
    RETURNING id` (reserved when a row comes back);
  - the release: `UPDATE … SET last_wake_at = NULL WHERE id = $key AND last_wake_at = $now RETURNING id`.
- **`NeedsYouEmailQuota` cannot run in `pg` yet.** `claimEmailSlot` goes through the helper's
  `insertIfAbsent` and `updateWhere`, which throw `not supported in pg mode until step 4`. Before this model
  runs in `pg`, the claim needs a single-statement Postgres form with the same answer, bumping `pg_version`
  and tested on real Postgres with racing claims on a fresh and a partly used day: `INSERT … (count = 1)
  ON CONFLICT (recipient_user_id, day) DO UPDATE SET count = needs_you_email_quotas.count + 1 WHERE
  needs_you_email_quotas.count < $limit RETURNING id` (a slot taken when a row comes back). Until then,
  don't set it to `pg`. The refusal comes after `sendNeedsYouEmail` has saved its claim, so each email
  would be marked failed and silently dropped.
- **`AgentComputerTakeover` cannot run in `pg` yet.** `setTakeover` and `bindTarget` go through the
  helper's `updateWhere` and `insertIfAbsent`, which throw `not supported in pg mode until step 4`; `listBindings`
  already reads Postgres in `pg-read` and `pg`; the guard `isTakeoverActive` reads Mongo until `pg`. Before this model runs
  in `pg`, each write needs a single-statement Postgres form keyed by the owner, bumping `pg_version` and
  tested on real Postgres with racing first writes and with another owner's installation id: `INSERT …
  ON CONFLICT (id) DO UPDATE SET active = $active WHERE agent_computer_takeovers.owner_id = $owner
  RETURNING id` (and the same for `target_id`, inserting `active = false`). No row back means another owner
  holds the id, and it must fail as Mongo's duplicate key does, never write. Until then, don't set it to
  `pg`: every takeover request and target bind would fail.

  **The takeover guard stays on Mongo in `pg-read`.** pg-read's flag check is a per-process cache, so
  another process's failed copy of `setTakeover(true)` can go unseen for up to 5 seconds, and a Postgres
  read would show the takeover as inactive and let the agent act during the person's takeover. Checking
  `repair` before the flip doesn't cover a copy that fails after it. In `pg` the guard reads Postgres,
  which is then the only store.
- **`BillingEvent` cannot run in `pg` yet.** `claimBillingEvent` refuses in `pg` before any write, and
  `recordBillingOutcome` goes through the helper's `updateWhere`, which throws `not supported in pg mode
  until step 4`. In `mongo`, `dual` and `pg-read` the lock is Mongo's unique index on `eventId`. In `pg` it
  must be Postgres's unique `event_id`: before this model runs in `pg`, the claim needs `INSERT … ON
  CONFLICT (event_id) DO NOTHING RETURNING id` (claimed when a row comes back, a duplicate otherwise), and
  the record an `UPDATE … WHERE event_id = $1` that bumps `pg_version` and leaves an absent `customer_id` as
  it is. Both need tests on real Postgres with racing deliveries of one event. The helper's pg-only
  `create` is not enough: it conflicts on `id`, so a second delivery would hit the `event_id` index with
  23505, not 11000, and fail instead of reading as a duplicate. Until then, don't set it to `pg`. Every
  webhook would answer 500, and an event Stripe stops retrying after three days would never be applied.

  **The switch to `pg` for this model is stop-the-world, never rolling.** Mongo's unique `eventId` and
  Postgres's unique `event_id` don't coordinate. If a replica still in `dual` makes a Mongo claim and a
  replica already in `pg` claims the same event before that claim's copy lands, both process it. A single
  `repair` check beforehand doesn't close that window, because a claim can land after the check. So:
  1. Stop every replica that still claims in Mongo: every backend replica, including the one that runs
     the scheduler (so its five-minute `repair` job stops too). While none is up, webhooks get no 2xx
     and Stripe retries them.
  2. From a one-off container that serves no traffic, with `STORE_MODE_BILLING_EVENT=dual`, run
     `node dist/scripts/dual-store-backfill.js --model BillingEvent --apply`, then `--verify`. `--apply`
     copies every live document at its current version, including any still marked pending, and the
     copy is version-guarded. `--verify` must report missing 0, differs 0 and equal checksums; if not,
     run `--apply` again. Don't rely on the scheduler's `repair` here: it was stopped in step 1, and it
     does nothing in `pg`. Now no Mongo-only claim is left uncopied.
  3. Only then start replicas in `pg`. Never run a `dual` or `pg-read` replica alongside a `pg` one for
     this model.
- **`DiscordSummaryHistory` cannot run in `pg` yet.** `recordDiscordSummary` refuses in `pg` before any
  write. The helper's pg-only `create` would insert the row (the model is insert-only, keyed by a fresh
  ObjectId, with no unique index besides `_id`), but it builds the row from `new Model(doc)` without
  `save()`, so it runs no schema validation and sets no `updatedAt`. Before this model runs in `pg`, its
  insert needs to validate the document first (`validate()` on the new document) and set `updatedAt` (the
  schema default already sets `createdAt`),
  tested on real Postgres. Until then, don't set it to `pg`: both writers would fail after they have
  queued the summary for Commonly Bot, the Discord sync would report a failure, and the scheduler would
  leave the buffer uncleared, so the same messages would be summarized again on the next run.
- **`NeedsYouEmail` cannot run in `pg` yet.** `claimNeedsYouEmail` and `setNeedsYouEmailStatus` refuse in
  `pg` before any write, and `markNeedsYouClicked` and `markIncludedInDigest` go through the helper's
  `updateWhere` and `updateManyWhere`, which throw `not supported in pg mode until step 4`. In `mongo`, `dual`
  and `pg-read` the claim's lock is Mongo's unique index on `attentionItemId`. Before this model runs in
  `pg`, each write needs a single-statement Postgres form, bumping `pg_version` and tested on real Postgres:
  - the claim: `INSERT … ON CONFLICT (attention_item_id) DO NOTHING RETURNING id` (claimed when a row comes
    back), tested with racing sends of one item. The helper's pg-only `create` conflicts on `id`, so a second
    send would hit the `attention_item_id` index with 23505, not 11000, and fail instead of reading as
    already claimed;
  - a status change: `UPDATE … SET status = $s, sent_at = COALESCE($sentAt, sent_at) WHERE id = $id`;
  - the first click: `UPDATE … SET clicked_at = $now WHERE id = $id AND clicked_at IS NULL`;
  - the digest mark: `UPDATE … SET included_in_digest_at = $at WHERE id = ANY($ids) AND
    included_in_digest_at IS NULL`, returning the count.

  Until then, don't set it to `pg`: `sendNeedsYouEmail` would log each refusal and send nothing. The switch
  is stop-the-world for the same reason as `BillingEvent`'s: Mongo's and Postgres's unique indexes don't
  coordinate, so a `dual` replica and a `pg` replica could each claim one item and both send it.

  **The click lookup stays on Mongo in `pg-read`.** A claim committed by another process whose copy failed
  can go unseen by this process's 5-second flag cache, and a Postgres read would answer unknown token: the
  link in an email the person has just received would go nowhere. The overflow read moves to Postgres in
  `pg-read`: a stale answer only delays a held ask to the next digest or shows it in one more, and the
  digest re-reads each ask from Mongo before showing it. A failed Postgres read there falls back to Mongo, so
  a Postgres outage never stops a digest.
