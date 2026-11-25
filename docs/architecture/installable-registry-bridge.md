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

- **Inserts missing rows; refreshes display fields on rows it created
  (marked), never on anything else.** An insert is
  `updateOne({ installableId }, { $setOnInsert }, { upsert: true, timestamps: false })`.
  `timestamps: false` matters: without it, mongoose adds `$set: { updatedAt }`
  and touches the existing row.
- **The refresh** (see [Display refresh](#display-refresh-on-marked-rows)) runs on
  an existing row only when it carries `origin: 'registry-backfill'` and one
  of its display fields differs from what the bridge would write for the
  registry row today. Each one is counted in `refreshed` (and still in
  `existing`). A row with nothing to change is not written, so a second pass is
  silent. A marketplace listing or a native-seeded builtin is never written.
  Nothing is deleted or `$unset`.
- It never reads or writes User, AgentInstallation, AgentProfile, memory or Pod.
- A duplicate-key race (E11000) counts as existing. A row that fails schema
  validation is counted in `errors` and skipped.
- Status and install-count drift on existing rows is counted in `mismatches`,
  not fixed, marked rows included.
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
  logs that it skipped. The pass line carries `refreshed=`. Turn it on only after a fresh backup. Run it by hand with
  `node dist/scripts/reconcile-installables-from-registry.js`, which is a dry
  run unless you pass `--apply`.

## Write-path mirrors

These paths write only AgentRegistry, so each one calls
`mirrorRegistryRow(row, site)`, the same insert-if-missing upsert. A mirror never
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

## Display refresh on marked rows

`refreshBridgeRow(registryRow, site)` keeps a backfilled Installable in step
when its AgentRegistry row is edited. Without it the reader's `on` mode would
serve the name or description the row had on the day it was backfilled.

- It writes only the row keyed `registryKeyOf(row)` that has
  `origin: 'registry-backfill'`. The mark is in the update filter itself, so a
  row a marketplace publish took over between the read and the write is not
  written.
- It `$set`s only the display paths, the same list the reader compares:
  `DISPLAY_FIELDS` and `DISPLAY_FIELD_PATHS` in `agentRegistryBridge.ts`, which
  `registryReader.ts` imports. They are `name`, `description`, `version`,
  `requires`, `marketplace.category`, `marketplace.tags`, and on the agent
  component `persona.avatar` and `metadata.registryRow.categories` (the view
  reads categories from there first). The values come from
  `registryToInstallable(row)`. A cleared `description` is written as the
  display name and a cleared `displayName` as the agent name, so neither is
  stored as `''`. A cleared `latestVersion` falls back to `manifest.version`,
  then to `'1.0.0'`. Other cleared values become `''` or `[]`. Refresh never
  writes `$unset`.
- It never changes `origin`, `source`, `owner`, `status` or
  `marketplace.published`, and never touches an identity table. **Status is
  not mirrored**: the reader takes it from AgentRegistry as a gate, and
  `published` is derived from status, so changing one without the other
  would leave a row that contradicts itself.
- It skips the write when nothing differs, and otherwise lets mongoose move
  `updatedAt`. It never throws: a failure logs `[installable-mirror] refresh`
  and the hourly sweep catches up.

Callers, each right after the AgentRegistry write that edits an existing row:

| Site | Edit |
|---|---|
| `PATCH /api/registry/agents/:name/owned-entry` | rename, retire or restore |
| `POST /api/registry/publish` | re-publish: version, description, display name, categories, tags, manifest |
| `POST /api/registry/seed` | the `updateOne` on an existing seed row |
| `agentBootstrapService.bootstrap` | the boot upsert, which `$set`s display fields on existing rows |
| `seed-native-agents` | the boot upsert. Its own Installable `$set` replaces `components`, so on a marked row the refresh restores the avatar, `requires` and taxonomy |

Not callers, by decision: marketplace publish's `syncToAgentRegistry` (it
writes AgentRegistry *from* the listing, which is unmarked), marketplace
unpublish (status only), the avatar routes (`mirrorRegistryAvatar` already),
the install claim's `$inc __v`, `unlist-internal-registry-agents` (sets
`ephemeral`, not a display field) and `migrate-guide-to-scout` (a one-off that
changes the key itself; the sweep inserts the new key). The hourly sweep is the
backstop for any path not listed, including direct DB edits.

## Read path (PR B)

Code: `backend/services/installable/registryReader.ts`. It's read-only: it
never writes Installable, AgentRegistry or any identity table.

Callers still query AgentRegistry exactly as before: filters, the catalog's
verified gate, ephemeral filtering, ownership, the name claim and every write
stay there. The reader takes the rows those queries returned, and
`INSTALLABLE_READ_PATH` decides what comes back. The flag is read on every call:

| Mode | What it serves | Installable query |
|---|---|---|
| `off`: unset, empty or unknown | the AgentRegistry rows, untouched (the same object) | none |
| `shadow` | the AgentRegistry rows, untouched; also compares and counts | one `$in` per read |
| `on` | display fields from Installable, everything else from AgentRegistry | one `$in` per read |

**Display fields:** `displayName`, `description`, `iconUrl`, `latestVersion`,
`categories`, `tags` and `manifest.context.required`. A site that projects
fewer fields passes only those; pod-agents passes `iconUrl`.

**`verified` and `status` are gates and are never compared or overlaid.** An
owner retire (`owned-entry`) changes AgentRegistry's status, and the display
refresh deliberately leaves the Installable's status alone. Overlaying them
would make a retired agent read as active.

**Only rows the bridge shaped are eligible**: `origin: 'registry-backfill'`,
or `source: 'marketplace'` (publish writes AgentRegistry too). Any other
Installable under a registry id is skipped and counted as `ineligible`, never
as drift. That covers the builtins `seed-native-agents` upserts itself
(no marketplace block, `requires` or registryRow) and connectors. Those rows
are served from AgentRegistry.

**Drift** is judged against what the bridge would write for the AgentRegistry
row today (`installableToRegistryView(registryToInstallable(row))`), not
against the raw row. Mapping losses therefore don't count as drift: an empty
description that falls back to the display name, a tag that repeats a
category, a missing `latestVersion`, or a marketplace listing published with
an empty description. In `on`, a field that hasn't drifted
keeps the AgentRegistry value, so `on` and `off` return the same bytes until
something actually drifts.

**Always from AgentRegistry, in every mode:** `defaultInstructions` (and all
of `configSchema`), `integrations`, `models`, `context.optional`,
`runtimeType`, `capabilities`, `publisher`, `registry`, `ephemeral`, `_id`,
`__v`, `versions`, `verified` and `status`. The backfill never copied `defaultInstructions`, and
the others don't round-trip reliably. In `on` the row is the AgentRegistry row
with the drifted display fields laid over it, never a row rebuilt from the view.

**`iconUrl` comes from Installable only on a backfilled row.** Marketplace
publish never writes `AgentRegistry.iconUrl` and doesn't check the avatar
(F615), so a listing's own avatar can't become a profile picture this way.

**Fallbacks.** A row with no usable name is never keyed or looked up. A
missing Installable, or one with no agent component, serves the AgentRegistry
row and counts as `missing` (plus `fallbacks` in `on`). A failed query is
counted in `errors` and serves the AgentRegistry rows. The request never fails
because of the reader.

### Switched sites

| Site | What moved |
|---|---|
| `GET /api/registry/agents` (catalog list) | the projected display fields of returned rows. `search()` and the verified and moltbot filters are unchanged |
| `GET /api/registry/agents/:name` (catalog detail) | display fields, including `manifest.context.required` |
| `GET /api/registry/pods/:podId/agents` and `/agents/:name` | `iconUrl` only. The seat's displayName is the installation's own |

All four are pure reads: no reader output reaches a write.

These stay on AgentRegistry: **`POST /api/registry/install`, entirely.** Its
registry values reach persistent writes (`AgentProfile.purpose` on every
reinstall, `AgentInstallation.version`, the installation and profile `name`, the
bot avatar seed). A stale Installable there would rewrite a profile, and a
rollback wouldn't undo it. Also on AgentRegistry: `/categories` (a filter vocabulary, not
rows); `templates.ts` (an existence check only); `personaHireService` (reads
only `verified`, which is the hire gate); and agentPodAddition,
runtimeIdentityOwnership, cloudRuntimeOwnership, owned-entry,
agentNameReservation and approvalActionService.

### Counters

The counters are kept in-process, per replica, since the last restart: `reads`, `rows`, `mismatchedRows`,
per-field counts, `missing`, `fallbacks`, `served` (rows `on` overlaid),
`errors`, `nameless` and `ineligible`. They're appended to the hourly `[registry-reconciler]` line
(`readPath=shadow reads=… mismatchedRows=… fields=displayName:3,…`); while the
flag is off and nothing has run, nothing is appended. Each mismatch also logs one
`[installable-read-path] mismatch site=… agent=… fields=…` line, at most 10
a minute per replica. The line has field names only, never values.

### Enablement order

1. Ship with the flag unset (`off`).
2. Set `shadow` on prod. Read the hourly lines for a few days.
3. Ship the display refresh and turn the sweep on, so the backlog of rows
   edited since the backfill is refreshed once (the first pass's `refreshed`
   count says how many). From then on the write paths refresh their rows as
   they edit them.
4. Investigate every remaining drifted field. Once shadow `mismatchedRows`
   stays near zero, `on` is safe for display fields. `missing` should also be
   near zero. A drift that persists names a write path the refresh doesn't
   cover yet.
5. Rollback is unsetting the flag. No data moves in any mode.
