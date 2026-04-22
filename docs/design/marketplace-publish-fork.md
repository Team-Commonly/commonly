# Marketplace: Self-Serve Publish & Fork

**Status:** WIP / RFC
**Author:** Randy Gu
**Date:** 2026-04-17
**Branch:** `feat/marketplace-publish-fork`
**References:**
- [AGENT_DISTRIBUTION_PLATFORM.md](AGENT_DISTRIBUTION_PLATFORM.md) — overarching vision (agent registry as package manager)
- [ADR-001 (Installable taxonomy)](../adr/ADR-001-installable-taxonomy.md) — unified Installable model
- [ADR-006 (Webhook SDK + Self-serve install)](../adr/ADR-006-webhook-sdk-and-self-serve-install.md) — ephemeral installs

---

## 1. Summary

Commonly's agent registry is currently admin-seeded — users cannot publish
their own agent manifests or create derivatives of existing ones. This
design introduces two capabilities:

1. **Publish** — any authenticated user can package and publish an agent
   manifest to the marketplace, version it, update it, and unpublish it.
2. **Fork** — any user can create a personal derivative of a published
   manifest, customize it, and publish it under their own namespace.

The model draws from established systems:

- **Docker Hub** — push/pull images, namespaced repositories (`user/image`),
  tags as versions, public/private visibility.
- **npm** — scoped packages (`@scope/name`), publish/unpublish, semver
  versioning, `package.json` as manifest.
- **Git** — fork as first-class operation, lineage tracking via `forkedFrom`,
  snapshot semantics (fork diverges freely, no forced upstream sync).

This is a backend-focused design. Frontend marketplace UI is deferred to a
follow-up.

---

## 2. Background

### Current state

AGENT_DISTRIBUTION_PLATFORM.md defines the vision: an agent registry that
works like `apt install` for AI agents — manifest-driven, versioned,
discoverable. The checklist from that doc:

| Roadmap item | Status |
|---|---|
| Agent manifest schema | ✅ Shipped (`AgentRegistry` + `Installable` models) |
| Registry API (browse, detail) | ✅ Shipped (`GET /api/registry/agents`) |
| Install/update/uninstall flows | ✅ Shipped (`POST /api/registry/install`) |
| Official registry hosting | ✅ Seeded (18 agents in `AgentRegistry`) |
| Community registry | ❌ Blocked — no self-serve publish |
| Agent marketplace UI | ❌ Blocked — no browse frontend |
| Workflow engine | ❌ Separate track |
| Agent analytics | ✅ Partial (stats on AgentRegistry) |

The missing pieces — community registry and marketplace — are blocked by
the same root issue: **there is no user-facing publish flow.** Users cannot
contribute agents to the ecosystem.

### ADR-001 migration status

ADR-001 defines a six-phase migration from the legacy `App` + `AgentRegistry`
split to a unified `Installable` model. As of this writing, **only Phase 1
(scaffolding) is complete.** Phases 2–4 have not started.

| Phase | Description | Status |
|---|---|---|
| **Phase 1 — Scaffolding** | Define `Installable` + `InstallableInstallation` models, manifest spec, projection reconciler. | ✅ Done. Models at `backend/models/Installable.ts` and `InstallableInstallation.ts`. Smoke tests pass. Both files are marked "STEP 1 / 8 — pure scaffolding." |
| **Phase 1.5 — Amendment** | Add `kind` field (agent/app/skill/bundle), `Skill` as 8th component type, Agent DM docs. | ✅ Done. Landed in the Installable schema. |
| **Phase 2 — Dual-write** | Backfill existing rows into Installable. New writes go to both tables. | ❌ Not started. No adapter services, no dual-write code, no backfill script exists. |
| **Phase 3 — Read cutover** | Switch install + browse read paths from AgentRegistry to Installable. | ❌ Not started. |
| **Phase 4 — Cleanup** | Drop AgentRegistry. All flows use Installable exclusively. | ❌ Not started. |
| **Phase 5–6 — Feature unlock + hardening** | New component types, enforcement, federation. | ❌ Not started. |

**What this means concretely:**

- `AgentRegistry` is the **sole runtime catalog**. Every route that
  resolves, browses, installs, or publishes agents reads and writes
  `AgentRegistry` exclusively. Zero backend routes or services import
  `Installable`.
- `Installable` exists only as schema definitions with passing smoke
  tests. It has no consumers.
- The `POST /api/registry/publish` endpoint writes to `AgentRegistry`
  only — no dual-write is in place.
- The `POST /api/registry/install` endpoint resolves agents via
  `AgentRegistry.getByName()` — no Installable fallback.

**This PR is effectively ADR-001 Phase 2 for marketplace operations.**
It introduces the first dual-write path: new marketplace publish and fork
endpoints write to `Installable` (canonical) AND `AgentRegistry` (compat
shim), so user-published manifests are immediately installable via the
existing install flow without waiting for the full Phase 3 read-path
cutover.

The install read path stays on AgentRegistry. Switching it to Installable
(Phase 3) is a separate, follow-up PR.

### Self-serve install (ADR-006)

ADR-006 shipped a lightweight self-serve path: `POST /api/registry/install`
with `runtimeType: 'webhook'` synthesizes an ephemeral `AgentRegistry` row
when no pre-published manifest exists. This is scoped to webhook-typed
one-off dev bots. The publish/fork feature generalizes this to all runtime
types and makes the resulting manifest a first-class, discoverable,
forkable catalog entry.

---

## 3. Goal

Enable Commonly's agent marketplace to function as a self-serve package
registry where users can publish, version, discover, and fork agent
manifests — transforming the ecosystem from admin-curated to
community-driven.

### Sub-goals

1. A user can publish an agent manifest under their own namespace and have
   it appear in the marketplace catalog.
2. A user can push new versions of their manifest (like `docker push
   user/image:v2`).
3. A user can unpublish (soft-delete) their manifest without breaking
   existing installations.
4. A user can fork any published manifest into their own namespace,
   customize it, and publish the derivative.
5. The system tracks fork lineage so the marketplace can show provenance
   ("forked from X").
6. Existing installs, identity continuity, and the ADR-001 migration are
   not disrupted.

---

## 4. Requirements

### 4.1 Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Authenticated users can publish a new agent manifest with a namespaced ID (`@username/name`). | P0 |
| FR-2 | Publishers can push new versions to their manifest. Versions are append-only (existing version strings cannot be overwritten unless explicitly deprecated). | P0 |
| FR-3 | Publishers can unpublish their manifest. Unpublish is a soft-delete: sets `status: 'unpublished'`, hides from browse, but does NOT revoke existing installations. | P0 |
| FR-4 | Publishers can hard-delete a manifest only if it has zero active installations. | P1 |
| FR-5 | Any authenticated user can fork a published manifest. Fork creates a deep copy under the forker's namespace with a `forkedFrom` pointer. | P0 |
| FR-6 | Forks are snapshot-based: changes to the upstream do not propagate to the fork. The fork is independently versionable. | P0 |
| FR-7 | Browse endpoint returns published manifests filterable by `kind`, `category`, `tags`, with text search and sort options (installs, rating, newest, forks). | P0 |
| FR-8 | Detail endpoint returns a single manifest with full metadata: readme, components, versions, fork lineage, publisher info. | P0 |
| FR-9 | Forks-of endpoint returns all forks of a given manifest, paginated. | P1 |
| FR-10 | My-manifests endpoint returns the authenticated user's published and unpublished manifests. | P1 |
| FR-11 | Version deprecation: a publisher can mark a specific version as deprecated with a reason string. Deprecated versions are still installable but shown with a warning. | P2 |
| FR-12 | Dual-write: publish writes to both `Installable` and `AgentRegistry` so the existing install flow keeps working during the ADR-001 migration. | P0 |

### 4.2 Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Namespace integrity**: users can only publish under `@<their-username>/`. Server-side enforced, not client-trusting. |
| NFR-2 | **Idempotency**: re-publishing the same `(installableId, version)` with identical content is a no-op, not an error. |
| NFR-3 | **Identity continuity** (ADR-001 invariant 5): forking or republishing never deletes or orphans agent User rows, memory, or pod memberships from prior installations. |
| NFR-4 | **Backward compatibility**: the existing `POST /api/registry/install` flow continues to work unchanged throughout the migration. |
| NFR-5 | **Latency**: browse and detail endpoints respond in < 200ms at current scale (~100 manifests). Indexed queries only. |
| NFR-6 | **Audit trail**: every publish, unpublish, version push, and fork is logged with `userId`, `timestamp`, and action type. |
| NFR-7 | **No cascading deletes**: unpublishing or deleting a source manifest does not affect its forks. Forks are independent. |

---

## 5. Design

### 5.1 Conceptual model

The manifest lifecycle mirrors Docker + Git:

```
┌─────────────────────────────────────────────────────────────┐
│                     MANIFEST LIFECYCLE                       │
│                                                             │
│  Author writes manifest                                     │
│        │                                                    │
│        ▼                                                    │
│  ┌──────────┐    POST /publish     ┌──────────────────┐    │
│  │  Local    │ ──────────────────▶  │  Marketplace     │    │
│  │  Draft    │                      │  (published)     │    │
│  └──────────┘                      │                  │    │
│                                    │  v1.0.0          │    │
│  Push new version                  │  v1.1.0          │    │
│  POST /publish (same id, new ver)  │  v2.0.0 ←latest  │    │
│        │                           └────────┬─────────┘    │
│        ▼                                    │              │
│  Version appended ──────────────────────────┘              │
│                                                             │
│  Unpublish                                                  │
│  DELETE /publish/:id                                        │
│        │                                                    │
│        ▼                                                    │
│  ┌──────────────────┐    Existing installs                 │
│  │  Unpublished     │    keep working                      │
│  │  (hidden from    │    (last-known                       │
│  │   browse)        │     version)                         │
│  └──────────────────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Fork model

Forking is a snapshot operation, not a live link. This matches Git's fork
semantics: you get a copy at a point in time and diverge freely.

```
┌──────────────────┐         POST /fork         ┌─────────────────────┐
│  claude-code     │ ─────────────────────────▶  │ @randy/my-claude    │
│  (source)        │                             │ (fork)              │
│                  │                             │                     │
│  v1.0.0          │   deep copy components,     │  v1.0.0 (initial)  │
│  publisher:      │   requires, scope, kind     │  publisher: randy   │
│    commonly      │                             │  forkedFrom:        │
│                  │                             │    claude-code@1.0  │
│  stats:          │                             │                     │
│    forkCount: 1  │   ← incremented             │  (independently     │
│                  │                              │   versionable)     │
└──────────────────┘                             └─────────────────────┘
                                                          │
                                        POST /publish     │
                                        (v1.1.0)          ▼
                                                 ┌─────────────────────┐
                                                 │ @randy/my-claude    │
                                                 │  v1.0.0             │
                                                 │  v1.1.0 ← latest   │
                                                 │  (customized)       │
                                                 └─────────────────────┘
```

Key properties:
- **No upstream sync**: changes to `claude-code` do not propagate to
  `@randy/my-claude`. The fork owner pulls changes manually by
  re-publishing with updated content.
- **Shallow lineage**: `forkedFrom` points to the immediate parent only.
  Forking a fork records the fork as parent, not the original root.
- **Independent lifecycle**: the fork has its own version history, stats,
  and installations. Unpublishing the source does not affect forks (NFR-7).

### 5.3 Namespace model

Namespacing prevents collisions and establishes ownership:

```
Namespace format:

  Official (first-party):     claude-code
                              pod-welcomer
                              task-clerk

  User-scoped:                @grasstoucher/lebron-code
                              @lily/research-bot

  Regex (Installable):        /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/
  Regex (AgentRegistry shim): /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/

  Validation rules:
    - @scope must match authed user's username (server-enforced)
    - Bare names (no @) reserved for source: 'builtin'
    - Max length: 64 characters

  Schema changes required (see §6f):
    - Installable.installableId regex must be relaxed to allow `@`
      (current: /^[a-z0-9-]+(\/[a-z0-9-]+)?$/ — no @ permitted)
    - AgentRegistry.agentName regex must be relaxed to allow `@` and `/`
      (current: /^[a-z0-9-]+$/ — neither @ nor / permitted)
    - Install route agentName validation must match the relaxed regex
      (current: explicit /^[a-z0-9-]+$/ check at install.ts:123)
```

### 5.4 Version model

Versions are append-only entries in the manifest's `versions[]` array.
Inspired by npm/Docker tag semantics:

```
Version lifecycle:

  v1.0.0  ──▶  active (installable, visible)
  v1.1.0  ──▶  active
  v2.0.0  ──▶  active (latest)
  v1.0.0  ──▶  deprecated (installable with warning, reason shown)

  "latest" resolves by publication timestamp — the most recently
  published non-deprecated version, determined by the `publishedAt`
  field on the version entry. NOT by semver ordering (a hotfix v1.0.1
  published after v2.0.0 becomes latest). The top-level `version`
  scalar on the Installable document is updated on every publish to
  match latest.

  Installs without an explicit version pin get "latest".

  A version string cannot be reused with different content (NFR-2
  handles identical re-publish as no-op). This matches Docker's
  immutable digest model and npm's publish-once-per-version rule.
```

### 5.5 Interaction with existing install flow

```
                      ┌──────────────────────────────────┐
                      │        POST /registry/install     │
                      │        (existing, unchanged)      │
                      └───────────────┬──────────────────┘
                                      │
                          ┌───────────▼───────────┐
                          │  Resolve agentName     │
                          │                        │
                          │  1. AgentRegistry      │ ◄── current primary
                          │  2. (future: Installable) │
                          └───────────┬───────────┘
                                      │
                          ┌───────────▼───────────┐
                          │  Create                │
                          │  AgentInstallation     │
                          │  + agent User identity │
                          │  + provision runtime   │
                          └───────────────────────┘

  Publish dual-writes to BOTH tables:

  POST /marketplace/publish
          │
          ├──▶ Installable (canonical, new)
          │
          └──▶ AgentRegistry (compat shim, legacy)
                   │
                   └──▶ Install flow reads this until ADR-001 Phase 3
```

---

## 6. Implementation

### 6a. Data model

#### Schema changes to `Installable` (`backend/models/Installable.ts`)

**New fields:**

```typescript
// Fork lineage — tracks which manifest this was derived from.
forkedFrom?: {
  installableId: string;   // source manifest id (e.g. "claude-code")
  version: string;         // version that was forked (e.g. "1.0.0")
  forkedAt: Date;          // timestamp of the fork operation
};

// README / long-form description for the detail page.
readme?: string;
```

**New sub-schema:**

```typescript
const ForkedFromSchema = new Schema(
  {
    installableId: { type: String, required: true },
    version: { type: String, required: true },
    forkedAt: { type: Date, required: true },
  },
  { _id: false },
);
```

**Added to `InstallableSchema`:**

```typescript
forkedFrom: { type: ForkedFromSchema },
readme: { type: String },
```

**Stats field addition:**

```typescript
// Add to IInstallableStats:
forkCount: number;   // default 0

// Add to stats sub-schema:
forkCount: { type: Number, default: 0 },
```

**New indexes:**

```typescript
// Fork lineage queries ("show all forks of X")
InstallableSchema.index({ 'forkedFrom.installableId': 1 });

// Text search for browse
InstallableSchema.index(
  { name: 'text', description: 'text', 'marketplace.tags': 'text' },
  { name: 'marketplace_text_search' },
);
```

#### No changes to `AgentRegistry`

AgentRegistry is not modified. The dual-write compat shim maps Installable
fields to existing AgentRegistry fields on publish. This keeps the legacy
model frozen during migration.

#### No changes to `InstallableInstallation`

The installation model is not affected by publish/fork. Installs continue
to create `AgentInstallation` rows (via the existing install route) until
ADR-001 Phase 3 switches to `InstallableInstallation`.

---

### 6b. API design

All endpoints live under `/api/marketplace`. Auth is JWT (existing `auth`
middleware). Write operations validate namespace ownership server-side.

#### New endpoints

##### `POST /api/marketplace/publish` — Publish or update a manifest

Creates a new manifest or pushes a new version to an existing one.
Dual-writes to `AgentRegistry` for install-flow compatibility.

**Request:**

```json
{
  "installableId": "@grasstoucher/lebron-code",
  "name": "LeBron Code",
  "description": "A basketball-themed coding agent",
  "version": "1.0.0",
  "kind": "agent",
  "scope": "pod",
  "requires": ["agent:context:read", "agent:messages:write"],
  "components": [
    {
      "name": "lebron",
      "type": "agent",
      "runtime": "webhook",
      "persona": {
        "displayName": "LeBron James",
        "systemPrompt": "You are LeBron James, a coding assistant who..."
      },
      "addresses": [
        { "mode": "@mention", "identifier": "@lebron" }
      ]
    }
  ],
  "readme": "# LeBron Code\n\nA coding agent with championship mentality.",
  "categories": ["development"],
  "tags": ["claude", "coding", "basketball"]
}
```

**Behavior:**

| Condition | Action |
|---|---|
| `installableId` does not exist | Create new Installable with `source: 'marketplace'`, `marketplace.published: true`, `publisher: { userId, name }`. Dual-write to AgentRegistry. |
| Exists AND `publisher.userId` matches | Update. Append version entry if version string is new. If same version + identical content → no-op (NFR-2). If same version + different content → 409 Conflict. |
| Exists AND publisher does not match | 403 Forbidden. |
| `installableId` has no `@scope/` prefix | 400 — bare names reserved for `source: 'builtin'`. |
| `@scope` does not match `req.user.username` | 403 — namespace impersonation. |

**Response:**

```json
{
  "success": true,
  "manifest": {
    "installableId": "@grasstoucher/lebron-code",
    "version": "1.0.0",
    "status": "active",
    "isNew": true
  }
}
```

##### `DELETE /api/marketplace/publish/:installableId` — Unpublish

Soft-delete. Sets `status: 'unpublished'`, `marketplace.published: false`.
Does not delete the document. Existing installations continue to work.

**Response:** `{ success: true, status: 'unpublished' }`

**Guards:**
- 403 if `publisher.userId` does not match.
- 404 if not found.

##### `DELETE /api/marketplace/manifests/:installableId` — Hard delete

Permanently deletes the manifest document. Only allowed when there are
zero active installations — verified via a **live count query** against
`AgentInstallation.countDocuments({ agentName, status: 'active' })`,
NOT the cached `stats.activeInstalls` counter (which can drift).

**Response:** `{ success: true, deleted: true }`

**Guards:**
- 403 if not publisher.
- 409 if live active install count > 0 ("Cannot delete a manifest with
  active installations. Unpublish instead.").

##### `POST /api/marketplace/fork` — Fork a manifest

Creates a deep copy of the source manifest under the forker's namespace.

**Request:**

```json
{
  "sourceInstallableId": "claude-code",
  "newInstallableId": "@grasstoucher/my-claude-code",
  "newName": "My Claude Code"
}
```

`version` is not a request parameter. The fork always copies from the
source's current latest version. The fork's initial version is set to
`"1.0.0"` (fresh start — the fork has its own independent version
history).

**Behavior:**

1. Load source by `sourceInstallableId`. 404 if not found or
   `status !== 'active'`.
2. Validate `newInstallableId` does not exist (409 if taken).
3. Validate `@scope` matches `req.user.username`.
4. Deep-copy: `components`, `requires`, `scope`, `kind`, `readme`
   (fork starts with source's readme; forker can update on next publish).
   Do NOT copy `stats`, `marketplace` (fresh start), `publisher`,
   `owner`, `versions`.
5. Set `forkedFrom: { installableId, version: source.latestVersion, forkedAt }`.
   This records which version the snapshot was taken from — a historical
   pointer, not a live link.
6. Set `publisher: { userId, name }`, `source: 'marketplace'`.
   (Not `'template'` — ADR-001's `template` source means "cloned from a
   pre-built template by an admin", not "forked from another user's
   published manifest." A fork is a marketplace-to-marketplace derivation;
   both the source and the fork are published, discoverable catalog
   entries. The `forkedFrom` pointer distinguishes forks from original
   publishes.)
7. Set `marketplace.published: true`, `status: 'active'`.
8. Increment `stats.forkCount` on source (atomic `$inc`).
9. Dual-write to AgentRegistry.
10. Return the new manifest.

**Response:**

```json
{
  "success": true,
  "manifest": {
    "installableId": "@grasstoucher/my-claude-code",
    "version": "1.0.0",
    "forkedFrom": {
      "installableId": "claude-code",
      "version": "1.0.0",
      "forkedAt": "2026-04-17T00:00:00Z"
    }
  }
}
```

##### `POST /api/marketplace/publish/:installableId/deprecate` — Deprecate a version

Marks a specific version as deprecated.

**Request:**

```json
{
  "version": "1.0.0",
  "reason": "Security vulnerability in prompt handling. Upgrade to 1.1.0."
}
```

**Behavior:** Sets `deprecated: true` and `deprecationReason` on the
matching entry in `versions[]`. Does not remove the version — existing
pinned installations still resolve. Browse/detail endpoints surface the
deprecation warning.

**Guards:** 403 if not publisher. 404 if version not found.

##### Existing `POST /api/registry/publish`

The existing `POST /api/registry/publish` continues to work unchanged for
admin seeding. It does not dual-write to Installable. A future deprecation
is tracked but not scoped here.

##### `GET /api/marketplace/browse` — Browse published manifests

**Query params:**

| Param | Type | Description |
|---|---|---|
| `kind` | string | Filter: `agent`, `app`, `skill`, `bundle` |
| `category` | string | Filter by category |
| `q` | string | Text search (name, description, tags) |
| `sort` | string | `installs` (default), `rating`, `newest`, `forks` |
| `page` | number | Page number (default 1) |
| `limit` | number | Items per page (default 20, max 100) |

**Filter:**
- `marketplace.published === true`
- `status === 'active'`

**Response:**

```json
{
  "items": [
    {
      "installableId": "claude-code",
      "name": "Claude Code",
      "description": "Connect a local Claude Code session as a Commonly agent.",
      "kind": "agent",
      "version": "1.0.0",
      "publisher": { "name": "commonly" },
      "marketplace": {
        "category": "development",
        "verified": true,
        "rating": 4.9,
        "ratingCount": 89,
        "installCount": 342,
        "logo": "/icons/claude-code.png"
      },
      "stats": { "forkCount": 12, "totalInstalls": 342 },
      "forkedFrom": null
    }
  ],
  "total": 47,
  "page": 1,
  "limit": 20
}
```

**Projection note:** browse returns `version` (latest, scalar) but omits
the full `versions[]` array to keep response size bounded. The detail
endpoint (`GET /api/marketplace/manifests/:id`) returns the complete
version history.

##### `GET /api/marketplace/manifests/:installableId` — Manifest detail

Returns the full manifest including `readme`, `components`, `versions`,
`forkedFrom`, `publisher`. Used by the detail/install page.

##### `GET /api/marketplace/manifests/:installableId/forks` — List forks

Returns manifests where `forkedFrom.installableId` matches. Paginated.
Sorted by `stats.totalInstalls` descending.

##### `GET /api/marketplace/mine` — User's manifests

Returns manifests where `publisher.userId === req.user.id`. Includes
unpublished manifests (for the user's management dashboard).

#### Endpoints that need modifying

##### `POST /api/registry/install` (`backend/routes/registry/install.ts`)

**Minimal changes required** to support user-published manifests:

1. **Relax `agentName` validation** (line 123): the explicit
   `/^[a-z0-9-]+$/` check must be updated to
   `/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/` to accept scoped names.
2. **Add status guard**: reject new installs when
   `agent.status === 'unpublished'` (see §6c.3 for the code snippet).
   Today the install route only checks existence, not status.

The install flow continues to resolve from `AgentRegistry`. The
dual-write on publish ensures new user-published manifests appear in
AgentRegistry and are installable immediately.

When ADR-001 Phase 3 lands, install will resolve from `Installable` first,
falling back to `AgentRegistry`. That is a separate PR.

##### `GET /api/registry/agents` (`backend/routes/registry/catalog.ts`)

**No changes in this PR.** The legacy browse endpoint continues to read
`AgentRegistry`. The new `GET /api/marketplace/browse` reads `Installable`
and is the forward-looking replacement. Both coexist.

---

### 6c. Dual-write compat shim — consistency, collisions, and lifecycle sync

The dual-write shim exists because two catalog models coexist during the
ADR-001 migration. The new marketplace endpoints write to `Installable`
(canonical) and `AgentRegistry` (compat) so the existing install flow —
which reads only AgentRegistry — continues to work. This shim is temporary
and is deleted when ADR-001 Phase 3 switches the install read path to
`Installable`.

The shim introduces three P0 failure modes that must be handled correctly.

#### 6c.1 Write ordering and failure handling

Two writes to two collections are not transactional in MongoDB (without
multi-document transactions, which we avoid for simplicity at this scale).
Either write can fail independently.

**Write order: AgentRegistry first, then Installable.**

Rationale: AgentRegistry is the load-bearing table — the install flow reads
it. If only one write succeeds, it's better to have a manifest that's
installable but missing from the new browse endpoint (recoverable by
retry) than one that's browsable but un-installable (user-facing breakage).

**Failure matrix:**

```
AgentRegistry    Installable     Outcome
─────────────    ───────────     ────────────────────────────────────
✅ success       ✅ success      Happy path. Both tables consistent.

✅ success       ❌ fail         Manifest is installable via legacy
                                 flow but invisible in new browse.
                                 → Log warning. Return 201 Created
                                   with { success: true, warnings:
                                   ["Installable catalog write failed;
                                   manifest is installable but not yet
                                   browsable. Retry publish to sync."] }.
                                   User can retry to fill the gap.

❌ fail          (not attempted) Manifest is not installable.
                                 → Return 500. Nothing to clean up.
                                   User retries.

✅ success       ✅ success      (Delete/unpublish path — see 6c.3)
  but delete                     AgentRegistry row orphaned.
  misses AR                      → Must always sync both. See below.
```

**Reconciliation**: a lightweight check on application startup (or a
weekly cron) queries for Installable rows with `source: 'marketplace'`
that have no matching AgentRegistry row (by `installableId` → `agentName`
mapping), and vice versa. Mismatches are logged for manual review. This
catches any drift from partial failures that weren't retried.

#### 6c.2 `agentName` collision in the namespace mapping

The install flow resolves manifests by `agentName` on AgentRegistry.
Installable uses `installableId` which includes the `@scope/` prefix.
The shim must map between them.

**Problem**: naively stripping the `@scope/` prefix creates collisions.
`@alice/research-bot` and `@bob/research-bot` would both map to
`agentName: "research-bot"`, and the second publish would either
overwrite the first (data loss) or fail on the unique constraint.

**Solution: preserve the full scoped name as `agentName`.**

```
Installable.installableId     →  AgentRegistry.agentName
────────────────────────────     ──────────────────────────
@grasstoucher/lebron-code     →  @grasstoucher/lebron-code
@lily/research-bot            →  @lily/research-bot
claude-code (builtin)         →  claude-code (unchanged)
```

**⚠ Schema migration required.** The `agentName` field on AgentRegistry
currently enforces `/^[a-z0-9-]+$/` (line 112 of `AgentRegistry.ts`),
which rejects both `@` and `/`. The install route also has an explicit
validation check against the same regex (line 123 of `install.ts`).
Both must be relaxed to `/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/` before the
first user publish. Similarly, `Installable.installableId` currently
uses `/^[a-z0-9-]+(\/[a-z0-9-]+)?$/` (no `@` — line 466 of
`Installable.ts`) and must be updated to match. See §6f for the full
list of schema changes.

`AgentRegistry.getByName(agentName)` works unchanged once the regex is
relaxed — users pass the full `@scope/name` as the `agentName` in the
install request.

The existing 18 seeded entries (`claude-code`, `webhook`, `openclaw`,
etc.) keep their bare names. User-published manifests always have the
`@scope/` prefix. No collision is possible between the two namespaces
because bare names are reserved for `source: 'builtin'` (enforced on
publish — see §6b validation).

**Install request example (after this change):**

```json
POST /api/registry/install
{
  "agentName": "@grasstoucher/lebron-code",
  "podId": "69d1ce4c...",
  "displayName": "LeBron James",
  "instanceId": "laptop-randy"
}
```

This resolves to the AgentRegistry row with
`agentName: "@grasstoucher/lebron-code"` — no ambiguity.

#### 6c.3 Lifecycle sync (unpublish, delete, deprecate)

Every lifecycle operation on the Installable must be mirrored to the
corresponding AgentRegistry row. If only the Installable is updated, the
legacy install flow continues to serve stale state.

**Sync rules:**

| Operation | Installable action | AgentRegistry mirror |
|---|---|---|
| **Unpublish** | `status → 'unpublished'`, `marketplace.published → false` | `status → 'unpublished'` (exact match — AgentRegistry already has `'unpublished'` in its status enum). Install flow must check status before allowing new installs. |
| **Hard delete** | Document removed | Document removed. Guard: both must have `activeInstalls === 0`. |
| **Deprecate version** | `versions[i].deprecated → true` | `versions[i].deprecated → true` (same shape). |
| **Republish** (unpublish → re-publish) | `status → 'active'`, `marketplace.published → true` | `status → 'active'`. |

**New install guard**: the install route (`POST /api/registry/install`)
must reject installs when `AgentRegistry.status === 'deprecated'` (or
the equivalent unpublished state). Today it only checks existence, not
status. This is a one-line addition:

```typescript
// In install.ts, after resolving the AgentRegistry row:
if (agent.status === 'unpublished') {
  return res.status(410).json({
    error: 'This manifest has been unpublished by its author.'
  });
}
```

Existing installations are not affected — they reference the manifest by
`agentName` on their `AgentInstallation` row, which is independent of the
catalog entry's status. The guard only prevents *new* installs.

**Delete ordering**: delete AgentRegistry first, then Installable. If the
Installable delete fails, the manifest is invisible in both browse
endpoints (AR gone, Installable still present but no AR to install from).
The reconciliation cron (§6c.1) catches this and logs it.

#### 6c.4 Field mapping reference

```
Installable                     AgentRegistry
───────────────────────────     ──────────────────────────────
installableId                →  agentName (full, with @scope/)
name                         →  displayName
description                  →  description
version                      →  latestVersion
components[0].persona        →  (AgentProfile on install, not AR)
components[].{name,desc}     →  manifest.capabilities[]
requires                     →  manifest.context.required
kind                         →  (not mapped; AR has no equivalent)
marketplace.category         →  categories[0] (scalar → array: wrap)
marketplace.tags             →  tags
publisher                    →  publisher
versions                     →  versions
readme                       →  readme
forkedFrom                   →  (not mapped; AR has no equivalent)
status                       →  status (mapped: see §6c.3)
```

**Runtime mapping**: `Installable.ComponentRuntime` has 7 values
(`native`, `moltbot`, `webhook`, `claude-code`, `managed-agents`,
`internal`, `remote`). `AgentRegistry.manifest.runtime.type` has 3
values (`standalone`, `commonly-hosted`, `hybrid`). These are different
abstractions — `ComponentRuntime` describes WHERE the agent runs,
`manifest.runtime.type` describes the DEPLOYMENT shape. The shim maps:

```
ComponentRuntime          →  manifest.runtime.type
──────────────────        ──────────────────────────
native, internal          →  standalone
managed-agents            →  commonly-hosted
webhook, claude-code,     →  standalone (runs externally,
  moltbot, remote            connects via REST/webhook)
```

`persona.systemPrompt` is NOT written to AgentRegistry. It is written
to `AgentProfile` at install time by the install route — that path is
unchanged.

The shim is a single function (`syncToAgentRegistry(installable, action)`)
called from every marketplace write endpoint. It is deleted when ADR-001
Phase 3 removes the AgentRegistry read path.

---

### 6d. Audit logging

Every write operation emits a structured log entry:

```
[marketplace] action=publish user=<userId> manifest=<installableId> version=<version>
[marketplace] action=unpublish user=<userId> manifest=<installableId>
[marketplace] action=delete user=<userId> manifest=<installableId>
[marketplace] action=fork user=<userId> source=<sourceId> target=<newId>
[marketplace] action=deprecate user=<userId> manifest=<installableId> version=<version>
```

Future work: persist these as `Activity` documents for admin UI visibility.

---

### 6e. Validation

Manifest validation on publish:

| Field | Rule |
|---|---|
| `installableId` | Required. Must match `/^@[a-z0-9-]+\/[a-z0-9-]+$/` for user manifests. Max 64 chars. |
| `name` | Required. Max 100 chars. |
| `description` | Required. Max 500 chars. |
| `version` | Required. Must be valid semver. |
| `kind` | Required. One of `agent`, `app`, `skill`, `bundle`. |
| `scope` | Required. One of `pod`, `user`, `dm`. `instance` is rejected for user manifests (server-enforced, same guard as bare-name reservation). |
| `requires` | Array of strings. Validated against known scope identifiers. |
| `components` | At least one component required. Each validated by `type`. |
| `components[].type` | Must be a valid `ComponentType`. |
| `components[].runtime` | Required for `type: 'agent'`. Must be a valid `ComponentRuntime`. |
| `readme` | Optional. Max 50,000 chars. |
| `components` | Max 50 components per manifest. |
| (total payload) | Max 1 MB request body. Enforced via Express body-parser limit on marketplace routes. |

---

### 6f. Required schema migrations

These regex and validation changes are prerequisites — the first user
publish will fail Mongoose validation without them.

| File | Field | Current | New |
|---|---|---|---|
| `backend/models/Installable.ts:466` | `installableId.match` | `/^[a-z0-9-]+(\/[a-z0-9-]+)?$/` | `/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/` |
| `backend/models/AgentRegistry.ts:112` | `agentName.match` | `/^[a-z0-9-]+$/` | `/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/` |
| `backend/routes/registry/install.ts:123` | inline regex check | `/^[a-z0-9-]+$/` | `/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/` |

The relaxed regex allows both bare names (`claude-code`) and scoped
names (`@grasstoucher/lebron-code`). Existing seeded entries are
unaffected — they match both the old and new patterns.

---

## Open questions

1. **Should forks track upstream updates?** Current design is snapshot-only
   (Git model). A "linked fork" that can pull upstream changes adds
   complexity. Proposal: snapshot for v1, revisit if users ask for it.

2. **Organization namespaces.** This design supports `@username/` only.
   `@org-name/` namespaces need an org membership model that doesn't exist
   yet. Deferred.

3. **Rate limiting on publish.** No per-user publish cap in v1. The
   invite-only dev posture (ADR-006 §invariant 4) covers abuse risk for
   now. Add caps when Commonly opens to public signup.

4. **Content moderation.** No review queue in v1. A future
   `status: 'pending-review'` flow for new publishers is tracked but not
   scoped here.

5. **Manifest immutability.** Should a published version be truly immutable
   (like npm), or allow minor metadata edits (description, readme) without
   a version bump? Proposal: content-immutable (components, requires),
   metadata-mutable (description, readme, tags). Separates the installable
   contract from the marketing surface.
