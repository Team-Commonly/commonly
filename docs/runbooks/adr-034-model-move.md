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
  copy. `alreadyCurrent` means Postgres already held that version or a newer one. `skippedPending` counts
  documents whose own copy is in flight or failed; the repair job copies those.
- **Verify:** `mongo` and `pg` are the row counts on each side. `missing` is a live document with no row,
  `differs` is a row whose fields differ (normalised the same way as the sampled compare), and `extra` is a
  row with no live document. A document marked deleted counts as absent.

A failed Postgres write never fails the caller. It leaves the document flagged (`pgPending`), and the
repair job copies it on its next pass. While any document of the model is flagged, `pg-read` reads Mongo,
including after a restart. A `pg-ahead` mismatch means Postgres holds a version Mongo never wrote, which
only a rollback from `pg` can produce. That case is out of scope until step 4 is lifted.
