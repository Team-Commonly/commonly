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
- **Installation tokens now get a live stamp in the same PR as the derivation.**
  `agentListenerCheckIn` stamps both copies of a token (the User row and
  `AgentInstallation.runtimeTokens`), and the WebSocket connect stamps an
  installation-only token as well. A token first used after the freeze therefore
  gets its `lastListenedAt` from its next poll instead of reading never-connected.
- **Order on prod:** deploy the check-in writer (#3114), run the backfill, then
  deploy the derivation. The derivation deploy is the only step that changes what
  a seat reads, and it is held until the apply is confirmed.
- **What changes after the switch.** `deriveAgentState` reads `lastListenedAt`, so a
  seat that has only made MCP calls reads never-connected and the stalled-connect
  scan nudges it, which is TASK-721. `/agent-states` keeps its `lastUsedAt` key,
  which now carries the last listener check-in.
- **Re-run the backfill right before the derivation deploy.** It only fills null or
  absent stamps, so a second run is safe. It closes the window for an
  installation-only token first used after the freeze and stopped before the deploy,
  which would otherwise read never-connected.
- **Two readers still use `lastUsedAt`.** `deriveAgentConnection`
  (`agentConnectionStateService`, the Your Team card) and the activity bucket read
  token use, and the credential ledger has no `lastListenedAt`. For an MCP-only seat
  the card can read connected while the room banner reads not connected. Tracked as a
  follow-up, not part of this switch.
