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
values outside the enum, such as `wrapper`), `runtimeShape`, `contextOptional`
and `capabilities`. `defaultInstructions` is not stored yet, because marketplace
detail and fork return component metadata; the read switch adds it when install
needs it. `metadata.registryRow` keeps what
`source` and `tags` cannot round-trip: `registry`, `ephemeral`, the full
`categories` list and `weeklyInstalls`.

`installableToRegistryView` returns the AgentRegistry-shaped fields that the
install route, the catalog, pod-agents, templates and persona hire read. A unit
test checks that each of those fields survives a round trip.

## Backfilled rows are not listings

Every row the bridge inserts carries `origin: 'registry-backfill'`, a top-level
schema field so routes can filter on it. It is **deny by default**:
`marketplace-api.ts` reaches Installable only through its `listings` helper,
which adds `origin: { $ne: 'registry-backfill' }` to every query. A route added
later inherits the exclusion. So browse, detail (the owner included), `/mine`,
forks, fork, unpublish, deprecate and delete all behave as if a marked row did
not exist. Fork also takes only a published `marketplace` row or a `builtin`.

Two named functions are the only exceptions. `installableIdTaken` answers yes
or no for a fork's new id. `findBackfillForTakeover` lets
`/api/marketplace/publish` take a marked row over. The namespace check has already
  decided who may publish that id, so the publish doc replaces the row whole,
  the mark is dropped, and the response is a normal create. That also covers a
  backfill that lands between publish's read and its create (E11000).

Publish and fork also hold an exclusive claim on the id from their admission
check through both writes (AgentRegistry, then Installable). Without it, two
concurrent requests for one id both passed admission, the last AgentRegistry
write won, and Installable kept the other request's doc, with nothing to
reconcile them. The claim is a `SchedulerHeartbeatLease` document with
`_id: 'installable-claim:<installableId>'`, acquired by a conditional upsert
that only matches an expired claim, so a second live request gets E11000 and
answers 409 `installable_id_busy` without writing. A crashed holder's claim
expires after 30 seconds and the next request takes the same document over; the
TTL index removes it eventually.

What is guaranteed: the claim is re-confirmed (and extended) immediately before
each write, the AgentRegistry write and each Installable write, by a
conditional update on `{ _id, ownerId, expiresAt > now }`. A holder whose claim
expired, for example after a stall, gets 409 and writes nothing more, so it
can't overwrite rows another request committed after taking the id over. The
one window left runs from a confirm until its write commits: a stall there (a
slow Mongo round trip, a long GC pause) lets a write confirmed under a live
claim land after the claim expired. Closing that needs
conditional writes in both collections, which the routes don't do.

The holder deletes only its own claim document (`{ _id, ownerId }`), up to three
attempts, and does so before the response goes out, so a client that retries
at once finds the id free. If the delete can't be confirmed and the response
carries `warnings`, one more warning tells the client to wait about 30 seconds,
until the claim expires. Tests: `__tests__/service/marketplace.idClaim.test.js`.

The avatar mirror changes marked rows only, so an installer's pick never
restyles a listing another publisher owns.

## The published rule

`marketplace.published` is true only for a row that is verified, active and
not ephemeral. That's the same line the hire catalog draws (ADR-022): smoke
seats, internal wrappers and self-serve rows are unverified or ephemeral. Browse
skips marked rows anyway; the flag is for the read switch, which reads
`published` as "hireable".

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
- A registry row with no usable `agentName` (null, missing or blank) is
  counted in `skipped` and never written. `registryKeyOf` is the one place a
  row's key is computed. `String(null)` once keyed a January seed row as the
  Installable `"null"` on the first prod sweep. The registry's unique
  `agentName` index admits at most one null-or-missing row, so only one such
  row can exist. Mirrors skip these rows the same way, and the deploy-time
  bootstrap writes through a mirror, which is why a roll can add rows while
  the flag is off.
- **Off by default.** The hourly job (:39, no lease, because every write is
  idempotent) sweeps only when `INSTALLABLE_REGISTRY_SWEEP=1`; unset, each tick
  logs that it skipped. Turn it on only after a fresh backup. Run it by hand with
  `node dist/scripts/reconcile-installables-from-registry.js`, which is a dry
  run unless you pass `--apply`.

## Write-path mirrors

These paths write only AgentRegistry, so each one calls
`mirrorRegistryRow(row, site)`, the same insert-only upsert. A mirror never
throws: a failure logs `[installable-mirror]`, and the sweep (once enabled) backfills
the row later.

- registry install, for the ephemeral self-serve row, except during a memory
  handoff (a failed handoff deletes that registry row)
- the approval card's ephemeral row
- commonly-bot in podController and podCurationService
- agentBootstrapService
- registry publish and seed

The avatar edit is different. `mirrorRegistryAvatar` changes only
`components.$.persona.avatar` on a marked Installable that already exists, and
on reset only while the avatar still holds the pick being undone.
