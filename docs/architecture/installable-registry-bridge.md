# AgentRegistry → Installable bridge

ADR-001 Phase 3, step 5 (read path), first slice. This slice changes no reads.
It makes sure every AgentRegistry row has an Installable row, so the read switch
can follow without a fallback for most rows.

Code: `backend/services/installable/agentRegistryBridge.ts` (pure mapping) and
`backend/services/installable/registryReconciler.ts` (sweep and mirrors).

## What the bridge maps

`installableId` is `agentName` lowercased. Marketplace publish and fork,
`seed-native-agents` and the sweep all use that key, so they can't create a
second row for the same agent.

| AgentRegistry | Installable |
|---|---|
| `displayName` | `name`, `components[agent].persona.displayName` |
| `latestVersion` (else `manifest.version`) | `version` |
| `manifest.context.required` | `requires` |
| `iconUrl` | `components[agent].persona.avatar` |
| `verified` | `marketplace.verified` |
| `categories[0]` | `marketplace.category` |
| `categories[1..]` + `tags` | `marketplace.tags` |
| `registry` / `ephemeral` | `source` (official → builtin, community → marketplace, private or ephemeral → user); `owner` is the publisher for `user` |
| `stats.installs` / `rating` / `ratingCount` | `stats.totalInstalls`, `marketplace.installCount` / `rating` / `ratingCount` |
| `manifest.runtime.runtimeType` | `components[agent].runtime`, when it is in the component enum (`moltbot` is) |

Installable has no column for some manifest fields. Those go in
`components[agent].metadata.registryManifest`: `runtimeType` (always, including
values outside the enum, such as `wrapper`), `runtimeShape`, `contextOptional`,
`capabilities` and `defaultInstructions`. `metadata.registryRow` keeps what
`source` and `tags` cannot round-trip: `registry`, `ephemeral`, the full
`categories` list and `weeklyInstalls`.

`installableToRegistryView` returns the AgentRegistry-shaped fields that the
install route, the catalog, pod-agents, templates and persona hire read. A unit
test checks that each of those fields survives a round trip.

## The published rule

`marketplace.published` is true only for a row that is verified, active and
not ephemeral. That's the same line the hire catalog draws (ADR-022): smoke
seats, internal wrappers and self-serve rows are unverified or ephemeral, so a
backfill can't put them into browse. Browse also requires
`source: 'marketplace'`, which leaves builtins out.

One consequence: an unverified agent published through marketplace publish
whose Installable write failed is backfilled unpublished. Republishing fixes it.

## Sweep guarantees (`sweepRegistryDrift`)

- **Insert-only.** Each row is `updateOne({ installableId }, { $setOnInsert }, { upsert: true, timestamps: false })`.
  `timestamps: false` matters: without it, mongoose adds `$set: { updatedAt }`
  and touches the existing row.
- An existing Installable is never changed. Nothing is deleted or `$unset`.
- It never reads or writes User, AgentInstallation, AgentProfile, memory or Pod.
- A duplicate-key race (E11000) counts as existing. A row that fails schema
  validation is counted in `errors` and skipped.
- Status and install-count drift on existing rows is counted in `mismatches`,
  not fixed.
- Runs hourly at :39 from `schedulerService` with no lease, because every write
  is idempotent. Run it by hand with
  `node dist/scripts/reconcile-installables-from-registry.js`, which is a dry
  run unless you pass `--apply`.

## Write-path mirrors

These paths write only AgentRegistry, so each one calls
`mirrorRegistryRow(row, site)`, the same insert-only upsert. A mirror never
throws: a failure logs `[installable-mirror]`, and the hourly sweep backfills
the row later.

- registry install, for the ephemeral self-serve row, except during a memory
  handoff (a failed handoff deletes that registry row)
- the approval card's ephemeral row
- commonly-bot in podController and podCurationService
- agentBootstrapService
- registry publish and seed

The avatar edit is different. `mirrorRegistryAvatar` changes only
`components.$.persona.avatar` on an Installable that already exists, and on
reset only while the avatar still holds the pick being undone.
