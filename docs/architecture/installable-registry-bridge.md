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
can't overwrite rows another request committed after taking the id over.

A confirm can't cover a stall inside the write that follows it (a slow Mongo
round trip, a long GC pause), so each write is also fenced. Once it holds the
claim, and before its first confirm, a request draws a fencing token: `$inc` on one counter, the
`system_settings` row `marketplace.installableClaimFence`. Each AgentRegistry
and Installable write the request makes carries `claimFence: { $not: { $gt:
token } }` in its own filter and stamps `claimFence: token` on the row in that
same write. The guarantees:

- **A stale write doesn't land on a newer holder's row.** Once a request with a
  higher token has written a row, a write from an older holder matches nothing:
  the AgentRegistry upsert falls through to an insert that the unique
  `agentName` index refuses (E11000, read as fenced, not as an error), the
  update path's conditional `updateOne` matches zero rows, and a takeover's
  `save()` (with the fence in `doc.$where`) misses. The stale holder answers
  409 `installable_id_busy`, and both rows stay exactly as the newer holder
  wrote them.
- **A stale write that lands first is replaced.** If the older holder's write
  reaches a row before the newer holder's does, the newer write matches it
  (lower token) and overwrites it. For a brand-new id, the stale Installable
  insert makes the newer insert hit E11000, and the newer holder takes that row
  over the same way it takes over a backfilled one. The update path writes
  every manifest field rather than only what changed, so the two rows agree.
  Before answering success, a holder checks whether it was superseded: a row
  now carries a newer token, or another request holds the claim document
  (every later acquire rewrites it with its own owner, so that request will
  overwrite these rows even if it hasn't written yet). Superseded answers 409.
  A lapsed claim alone doesn't: a slow holder with no competitor has won, and
  answers 201 (a 409 there would leave a fork uncounted and its retry told the
  id is taken).
- **Rows written before the fence have no token, which counts as lowest**, so
  they need no migration (`$not: { $gt }` matches a missing field; `$lte`
  wouldn't). The first fenced write stamps one.

Why a single counter: the claim document is deleted on release and by the TTL
monitor once expired, so a count kept on it would restart below a stalled
holder's token. Taken from one persistent row, the tokens rise across release,
re-acquire and TTL removal, need no clock, and need no new model (ADR-034 D4).
The token is drawn after the acquire and before the first confirm, so tokens
follow claim order: A's draw precedes A's confirm, which precedes A's expiry,
B's acquire and B's draw. A holder that stalls between acquire and draw may
draw above its successor, but it then fails the confirm before every write and
writes nothing. Drawing before the acquire inverts this: a request that stalls
there acquires later with a lower token than the holder it follows, and that
holder's in-flight write overwrites it. If the counter
row were ever lost, stored tokens would sit above every new one; a fenced write
raises the counter to the token that refused it (`$max`), so the client's retry
succeeds. Rejected alternatives: a token kept on the claim document (it
resets); a non-TTL counter document in the lease collection (it misuses a lease
model for a permanent row, and would need a far-future `expiresAt`);
clock-based tokens (they depend on host clocks agreeing); multi-document
transactions (they need a replica set, which self-host doesn't promise).

What isn't covered: a writer that doesn't stamp, such as a pod still running
the pre-fence code during a rolling deploy, or a `deprecate` or `unpublish`
call, which doesn't take the claim. Because the update path rewrites every
manifest field, a `deprecate` that lands during a version publish can have its
deprecation flag overwritten by the publish's copy of `versions`. Two
leftovers need a holder that stalled past its claim and was then superseded.
A superseded fork's row keeps `forkedFrom` (a later publish doesn't rewrite
it), but the source's `forkCount` isn't bumped, because the fork answered 409.
And an optional AgentRegistry field the newer publish omits, such as `readme`,
keeps the older holder's value, since `syncToAgentRegistry` only `$set`s the
fields it is given. That omission rule is older than the fence: a plain
re-publish without `readme` keeps the old one too. The fenced
AgentRegistry write also relies on the unique `agentName` index existing. The
token is internal: marketplace responses leave `claimFence` out.

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
owner retire (`owned-entry`) changes only AgentRegistry, and the sweep never
updates an existing Installable. Overlaying them would make a retired agent
read as active.

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
3. Investigate every drifted field. **`on` serves Installable values that go
   stale.** The sweep and mirrors insert and never update, so after an
   AgentRegistry rename or description edit (owned-entry rename, a registry
   publish edit), `on` keeps serving the old name or description until the
   bridge row changes. Shadow counts each of these as drift.
4. `on` waits until either shadow drift stays near zero, or the write paths
   (owned-entry rename and retire, registry publish edits) update the bridge
   row. Today neither is true for edited rows, so `on` would show stale names
   for them. `missing` should also be near zero.
5. Rollback is unsetting the flag. No data moves in any mode.
