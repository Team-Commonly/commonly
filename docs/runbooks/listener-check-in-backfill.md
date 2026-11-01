# Listener check-in backfill

`backend/scripts/backfill-listener-check-in.ts` gives every runtime token that has
been used a `lastListenedAt` equal to its `lastUsedAt`. It runs on prod BEFORE
agent state starts reading listener check-ins (TASK-721). Without it, every
seat whose last call was before `lastListenedAt` existed would flip from
gone-dark to never-connected on the deploy, and the stalled-connect nudge could
post into old rooms.

It covers both token stores: `User.agentRuntimeTokens` and
`AgentInstallation.runtimeTokens`.

## Run it

```bash
cd backend
# 1. Dry run. Prints the counts and freezes the candidate set (no token hashes).
node dist/scripts/backfill-listener-check-in.js --out ids.json
# 2. Apply only that set.
node dist/scripts/backfill-listener-check-in.js --apply --ids ids.json
```

`--apply` refuses to start without `--ids`. Re-running is harmless: a token that
already has `lastListenedAt` is counted as skipped.

## What it will not do

- Overwrite a stamp a running listener wrote after the dry run. Each write is
  guarded by `lastListenedAt: null` (absent or null, never a live Date) on that one token element.
- Replace an array or touch another field, so a concurrent `lastUsedAt` write is kept.
- Read, print or store a token hash.

## What it over-claims

A token that was only ever used for MCP tool calls gets a `lastListenedAt` too.
That is deliberate: it keeps the verdict agent state gave before the change. A
live listener's next poll writes the real value.

## Before the derivation switch ships

- The listener check-in writer (#3114) must already be live on prod. Otherwise a
  live listener keeps only its backfilled stamp and ages into gone-dark.
- Run the dry run once more after the apply. Some candidates will remain on a
  live system: tokens first used by an MCP call after the freeze, and any
  **unaddressable** ones. The report's `unaddressable` count is tokens whose
  subdocument has no ObjectId `_id`; the script cannot stamp them, and they would
  flip from gone-dark to never-connected. Resolve them (or accept them) first.
- A write that comes back unacknowledged counts as `failed`, never as skipped.
- **Deploy gate: installation tokens need a live stamp first.** Today only the
  User-row copy of a token is stamped on a listener check-in
  (`agentListenerCheckIn`, #3114). A token that exists only in
  `AgentInstallation.runtimeTokens`, backfilled or first used after the freeze, never
  gets a live `lastListenedAt`, so a derivation that reads the field would read it as
  gone-dark or never-connected. The derivation PR must not ship before that stamp
  exists.
