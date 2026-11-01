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
  guarded by `lastListenedAt: { $exists: false }` on that one token element.
- Replace an array or touch another field, so a concurrent `lastUsedAt` write is kept.
- Read, print or store a token hash.

## What it over-claims

A token that was only ever used for MCP tool calls gets a `lastListenedAt` too.
That is deliberate: it keeps the verdict agent state gave before the change. A
live listener's next poll writes the real value.

## Check it worked

The dry run's candidate count after the apply should be 0. Then confirm the
state derivation change is safe to deploy: no old seat should read
never-connected that read gone-dark before.
