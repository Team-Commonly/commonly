# Moving one model to Postgres (ADR-034 steps 2 and 3)

[ADR-034](../adr/ADR-034-postgres-single-store.md) D3 moves each Mongo model in four steps. This is the
operator procedure for steps 2 (dual) and 3 (read cut) of **one** model, run on staging first and then on
production. Step 4 (Postgres only, then dropping the Mongo code) is held until after 2026-11-30 and is not
covered here.

**Before you start, the model must already have:** step 1 done (callers go through its repository); the
repository built on `createDualStore` (`backend/repositories/dualStore.ts`); `dualStorePlugin` on its
schema; its table in a numbered migration that has run; and an entry in
`backend/repositories/dualStoreRegistry.ts`. The first model done this way is `AgentPodReadCursor`
(table `agent_pod_read_cursors`, migration `0016`).

**A model whose callers delete does not enter dual yet.** A completed delete removes the document and its
row, and the version with them, so a recreated id starts again at version 1 and a late copy, a pg-mode
compare-and-set or a backfill of the old document can land on it. The prerequisite is deletes as tombstones
in both stores that keep the version. Until then the helper's `remove` throws outside `mongo` unless the
store was created with `allowDeletes: true`, which is unsafe for exactly that reason.
`AgentPodReadCursor` has no delete path.

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
