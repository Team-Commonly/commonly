# ADR-002: Attachments & Object Storage

**Status:** Draft — 2026-04-14
**Author:** Lily Shen
**Supersedes:** (none — amends the ad-hoc implementation in `backend/routes/uploads.ts`)

---

## Context

Commonly currently lets users attach images to **posts**, **messages**, and **profile pictures**. All three flow through a single `POST /api/uploads/` endpoint (`backend/routes/uploads.ts`) and land in the `File` Mongoose model as an inline `Buffer`. Reads go through `GET /api/uploads/:fileName`, which has **no authorization check** — anyone who knows (or guesses) a filename can fetch the bytes.

### What's wrong with this

1. **Bytes in MongoDB.** `File.data: Buffer` means every image lives in the primary document store. IOPS shared with user/pod/post queries; backups balloon; `mongodump` time scales with total image volume.
2. **Backend-as-CDN.** Every view streams through a k8s pod. One viral image in a 50-member pod = 50× egress through our ingress.
3. **No auth on GET.** `/api/uploads/:fileName` is effectively public-read. A leaked URL from a private pod is as accessible as one from a public post.
4. **5 MB hard cap.** Symptom of the architecture, not a policy choice. Any larger would be painful.
5. **No thumbnails.** Chat renders full-resolution bitmaps.
6. **Unstructured references.** The file URL is pasted into post/message bodies as a string. Orphan detection is impossible; rich rendering (dimensions, preview, alt-text) is impossible; re-signing URLs per viewer is impossible.
7. **Tightly coupled storage.** Cannot swap to S3 / GCS without rewriting every call site.

Simultaneously, we want Commonly to be deployable at three scales:

- **Hosted (`commonly.me` / `commonly-dev`)** — GCP already available, GCS is natural.
- **Serious self-host** (a company running their own instance) — S3-compatible is the lingua franca; MinIO if they want everything local.
- **Hobbyist self-host** (someone on a home NAS / single VM) — doesn't want to stand up an object store; wants one-command install.

A hosted-only design strands the self-hosters. A Mongo-inline-only design strands the hosted instance (and doesn't scale past hobby).

---

## Decision

Introduce an **`ObjectStore` driver abstraction** (mirrors the pattern we already use for agent runtimes) and a **structured `attachments` reference model** on posts and messages. Bytes live in whichever store the deployment configures; metadata references live on the parent entity's document/row.

### Where things live

| What | Where | Note |
|---|---|---|
| **Attachment bytes** | `ObjectStore` driver (Mongo / filesystem / GCS / S3) | Driver-selected at deploy time. |
| **Attachment metadata (posts)** | MongoDB — `Post.attachments: IAttachment[]` | Parent lives in Mongo, so ride along. |
| **Attachment metadata (messages)** | PostgreSQL — `messages.attachments JSONB NOT NULL DEFAULT '[]'` | Parent lives in PG, so ride along. |
| **Attachment metadata (profile pictures)** | MongoDB — `User.profilePicture` → structured, not URL string | Same model, single attachment. |

### The `ObjectStore` interface

```ts
interface ObjectStore {
  /** Write bytes. Returns the storage key. */
  put(key: string, body: Buffer | NodeJS.ReadableStream, mime: string): Promise<void>;

  /**
   * Produce a short-TTL URL a client can GET directly from storage.
   * Drivers that can't sign (mongo, filesystem) may return `null` — in
   * that case the caller falls back to streaming through the backend via
   * `getStream(key)`.
   */
  getSignedReadUrl(key: string, ttlSeconds: number): Promise<string | null>;

  /** Stream bytes back. Used by drivers that don't sign, and as a fallback. */
  getStream(key: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size: number }>;

  delete(key: string): Promise<void>;

  /** Driver capability hints, used by the route layer. */
  readonly capabilities: {
    signedUrls: boolean;       // can we hand the client a direct URL?
    maxObjectBytes: number;    // upper safety bound for this driver
    name: 'mongo' | 'filesystem' | 'gcs' | 's3';
  };
}
```

### Drivers to ship

1. **`mongo` (default for `docker-compose.local.yml` / hobbyist self-host)**
   - Wraps the existing `File` model. Zero new dependencies.
   - `capabilities.signedUrls = false` → backend serves bytes on GET.
   - Recommended cap: **10 MB** per object.

2. **`filesystem` (serious self-host with a mounted volume)**
   - Writes to `/var/lib/commonly/media/<key>`.
   - Driver creates subdirs from the key prefix (`messages/2026/04/`) to avoid one flat directory.
   - `capabilities.signedUrls = false` → backend serves bytes on GET (can still offload to nginx via `X-Accel-Redirect` later).
   - Recommended cap: **100 MB** per object (disk-bound).

3. **`gcs` (default for `commonly.me` / `commonly-dev`)**
   - Bucket per-environment: `commonly-dev-media`, `commonly-media`.
   - Uses V4 signed URLs, 5-minute read TTL, 15-minute write TTL (for pre-signed PUTs if we add them later).
   - `capabilities.signedUrls = true` → 302 redirect (or JSON `{url}`) per request.
   - Recommended cap: **25 MB** per object for images, **100 MB** for other files.

4. **`s3` (S3-compatible, e.g. AWS S3 / MinIO / R2)**
   - Same interface, different SDK. Same defaults as `gcs`.

**Driver selected via env:**

```
OBJECT_STORE_DRIVER=mongo|filesystem|gcs|s3
OBJECT_STORE_BUCKET=...           # gcs/s3 only
OBJECT_STORE_PATH=/var/lib/...    # filesystem only
OBJECT_STORE_REGION=...           # s3 only
OBJECT_STORE_ENDPOINT=...         # s3 only (MinIO/R2)
```

Defaults: `mongo` on unset (preserves current dev behavior), `gcs` explicitly set in Helm values for `commonly-dev` and `commonly-prod`.

### Structured attachment reference

```ts
interface IAttachment {
  id: string;              // ULID, e.g. "01JA7R2KQ3..."  (not the storage key)
  kind: 'image' | 'file' | 'audio' | 'video';
  mime: string;            // validated against an allowlist at upload
  size: number;            // bytes
  name: string;            // original filename (display only)
  sha256: string;          // content hash, for dedupe + integrity
  storage_key: string;     // opaque to callers; driver-specific layout
  thumb_key?: string;      // present for image/video
  width?: number;          // images/videos
  height?: number;
  duration_ms?: number;    // audio/video
  uploaded_by: string;     // user or agent ID
  uploaded_at: string;     // ISO-8601
}
```

- `id` is the stable handle (`/api/media/:id`). `storage_key` can change across driver migrations without breaking references.
- `sha256` enables content-addressed dedupe — two identical uploads resolve to the same storage key under the hood.
- On **posts**: `Post.attachments: IAttachment[]` (embed in Mongo).
- On **messages**: `messages.attachments JSONB` (embed in PG). Rationale: attachments are always fetched with their message — no JOIN savings from a side table, and JSONB survives schema migrations well.
- On **profile pictures**: `User.profilePicture: IAttachment | null` (single, not array).

### API surface

**Upload (stream-through, start simple — can add pre-signed PUT later):**

```
POST /api/media
  auth: required
  multipart/form-data: file=<binary>
  → 201 { id, kind, mime, size, name, sha256, width?, height? }
```

The backend:
1. Authenticates the uploader (`auth` middleware).
2. Validates size against driver cap + MIME against allowlist.
3. Computes `sha256` while streaming to driver.
4. Synchronously generates a thumbnail for images <2 MB (libvips via `sharp`); queues async generation for larger images or video.
5. Creates an `Attachment` row (see "Server-side attachment registry" below) and returns the structured reference.

**Read (driver-aware):**

```
GET /api/media/:id
  auth: required
  → 200 with bytes              (mongo/filesystem drivers)
  → 302 to signed URL           (gcs/s3 drivers)
```

Authorization check: the requester must have access to **at least one** referencing post or message (scoped by pod membership, visibility rules). Cached per-request.

**Thumbnail:**

```
GET /api/media/:id/thumb
  → same behavior, for thumb_key
```

**Delete:** internal only. Users don't delete attachments directly; they delete the parent post/message, and a GC pass handles orphans (see below).

### Server-side attachment registry

Add a lightweight **`Attachment`** record (Mongo — it's global, rarely queried in joins):

```ts
interface IAttachmentRow {
  _id: string;              // same ULID as IAttachment.id
  kind, mime, size, name, sha256, storage_key, thumb_key, width, height, duration_ms,
  uploaded_by: ObjectId,
  uploaded_at: Date,
  ref_count: number;        // incremented on post/message insert referencing this id
  last_referenced_at: Date; // for GC of long-orphaned files
}
```

This row is the **source of truth** for the file. The embedded `IAttachment` in posts/messages is a denormalized snapshot for rendering without a lookup.

- On post/message insert: increment `ref_count` for each embedded attachment ID.
- On post/message delete: decrement.
- Nightly GC job: `ref_count == 0 AND last_referenced_at < 24h ago` → delete from object store + delete the row.

### Self-hosted implications

| Deployment shape | Driver | Notes |
|---|---|---|
| `docker-compose.local.yml` (hobbyist) | `mongo` | Zero config. Bytes in Mongo; 10 MB cap. |
| Helm + volume mount (small self-host) | `filesystem` | Mount a PV at `/var/lib/commonly/media`. 100 MB cap. Back up the volume. |
| Helm + MinIO sidecar (serious self-host) | `s3` + `OBJECT_STORE_ENDPOINT=http://minio:9000` | MinIO chart as optional dependency in our Helm chart. |
| Hosted `commonly-dev` / `commonly-prod` | `gcs` | Signed URLs, dedicated bucket per env, IAM SA with `storage.objectAdmin` on the bucket only. |

**Helm values sketch:**

```yaml
objectStore:
  driver: gcs                       # default for hosted
  bucket: commonly-dev-media
  # filesystem driver:
  # persistence:
  #   enabled: true
  #   size: 50Gi
  #   mountPath: /var/lib/commonly/media
  # s3/minio driver:
  # endpoint: http://commonly-minio:9000
  # accessKeyExistingSecret: minio-creds
```

---

## Consequences

### Positive

- **Backend egress flat.** On hosted, 10 MB image → 50 viewers = 50 direct GCS fetches, not 500 MB through k8s ingress.
- **Primary DB stays lean.** New images no longer bloat Mongo.
- **Auth properly enforced.** `GET /api/media/:id` checks pod/post access before signing a URL or streaming bytes. Closes the current public-read gap.
- **Scales both directions.** Hobbyist: zero-config Mongo. Enterprise: GCS/S3 with CDN in front.
- **Protocol alignment.** Makes `attachments` a first-class field in the CAP message contract, matching what external runtimes (OpenClaw, webhook agents) will need.
- **Dedupe.** Content-addressed via `sha256`; the same image posted twice costs one object.

### Negative / risks

- **Migration work.** Existing `File` documents and the inline URL strings in posts/messages need a one-time backfill to the new structured model. Detailed in "Migration plan" below.
- **More moving parts.** Driver abstraction, `Attachment` registry, GC job, thumbnail pipeline — each a small thing, but together nontrivial.
- **GCS costs new line item.** At current dev volume (small), probably pennies/month. At `commonly.me` scale, depends on media-heavy usage. Mitigated by CDN (Cloud CDN / Cloudflare in front of the bucket) and by the 7-day TTL on signed URLs preventing hot-linking.
- **Signed URL leakage.** Anyone who grabs a signed URL within its 5 min TTL can re-share. Trade-off: shorter TTL = more backend round-trips, longer TTL = larger leak window. 5 min feels right; adjust if needed.

### Security notes

- **SVG upload is a known XSS vector.** Recommendation: either block SVG entirely from user uploads, or serve SVGs with `Content-Security-Policy: default-src 'none'` and `Content-Disposition: attachment` (which breaks inline rendering — probably not what users want). Default: **block SVG** except from admin uploads.
- **MIME allowlist (not extension-based):** `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `application/pdf`, `text/plain`, `audio/*`, `video/mp4`. Validate via magic bytes (`file-type` npm package), not the client-declared `Content-Type`.
- **Size limits enforced at driver level**, with a route-layer check as the first gate.
- **Virus scanning:** deferred. Add when we accept arbitrary file types beyond images; ClamAV in a sidecar is the usual path.
- **Content moderation:** deferred. Image safety classifier (Google Cloud Vision SafeSearch or similar) can be added as an async post-upload step for hosted only.

---

## Alternatives considered

### A. Stay on `File` inline buffer

Rejected. Primary-DB bloat is already observable at dev scale; breaks backups and restore-time SLOs at any serious scale.

### B. GridFS (MongoDB's own blob mechanism)

Rejected. GridFS still puts bytes in Mongo and adds a second IO path; offers no advantages over the current inline buffer except slightly better chunking. Industry consensus: don't.

### C. GCS-only (no driver abstraction)

Rejected. Strands self-hosters. Also makes local dev depend on GCS creds or a real bucket, which is friction for OSS contributors.

### D. Single driver, but URL-based (upload proxy forwards to a configured URL)

Considered briefly — e.g., "point it at any HTTP upload endpoint you want." Rejected because sign/verify semantics differ enough between S3, GCS, and local that a real interface is less work than papering over them.

### E. Pre-signed client-direct upload (PUT straight to GCS from browser)

Deferred. The `POST /api/media` stream-through keeps upload simpler to reason about (synchronous validation, sha256, thumbnail) and keeps the API surface identical across drivers. The API shape is compatible with a later move to pre-signed PUTs — just add a `POST /api/media/presigned-put` endpoint; existing calls keep working.

---

## Implementation plan

### Phase 1 — Abstraction without behavior change (one PR)

**Goal:** Introduce the driver interface, route bytes through it, no user-visible change.

- [x] `backend/services/objectStore/ObjectStore.ts` — interface.
- [x] `backend/services/objectStore/drivers/mongoDriver.ts` — writes bytes to a new `MediaObject` collection (decoupled from `File`, which continues to hold display/ownership metadata for Phase 1 compat).
- [x] `backend/services/objectStore/index.ts` — singleton; selects driver from `OBJECT_STORE_DRIVER` env (defaults to `mongo`).
- [x] Refactor `backend/routes/uploads.ts` to call the driver; GET falls back to legacy `File.data` for pre-ADR-002 records; size cap driven by driver capability (multer `limits.fileSize`).
- [x] Make `File.data` optional so new records are metadata-only; legacy records remain readable.
- [x] Tests: mongo driver contract, env-based selection, and route GET/POST (driver path, legacy fallback, 404, metadata-only save).

**Scope discipline:** `filesystem` and `gcs`/`s3` drivers are deferred to their respective phases. Shipping `filesystem` in Phase 1 without a Helm caller would be half of Phase 5 dressed as Phase 1 (REVIEW.md §Over-engineering: *"no abstraction for <3 current users"*). One production driver is enough to validate the interface; contract tests cover behavioral parity.

**No data migration needed** — schema change is additive (`File.data` optional; `MediaObject` is a new collection), route paths unchanged, existing records still readable via the route's fallback.

### Phase 1b — Close the GET authorization gap (followup PR)

**Split out of Phase 1** because the real fix requires coordinated frontend + backend changes: adding plain `auth` middleware on `GET /api/uploads/:fileName` breaks every `<img src>` in the app (browsers do not attach `Authorization` headers to image requests), and cookie auth isn't currently wired for the API. Phase 1 therefore leaves GET's existing public-read behavior untouched.

- [ ] Backend: issue short-TTL (5 min) signed tokens scoped to `fileName + viewerUserId`; GET accepts `?t=<token>` alongside header auth.
- [ ] Backend: per-request ACL check before minting the token — requester must own the file or have read on a pod/post that references it. Phase 1 references are URL substrings (slow scan); Phase 2's structured `attachments` makes this an indexed lookup.
- [ ] Frontend: `rewriteAttachmentUrl(url)` helper at render time that calls `GET /api/media/:id/url` and caches the signed URL until expiry.
- [ ] Rate limiting on the token-mint endpoint.
- [ ] Audit log entry on each mint (`file_id, viewer_id, ip`).

**Ships before:** any production-scale launch. The ADR-002 invariant in REVIEW.md §Attachments is not satisfied until Phase 1b is live.

### Phase 2 — Structured `attachments` model (one PR)

**Goal:** Move posts and messages from inline URL strings to structured attachment references.

- [ ] `Attachment` model (Mongo) with `ref_count` / `last_referenced_at`.
- [ ] New ULID-based `id` per upload. Keep serving existing `/api/uploads/:fileName` for backward-compat.
- [ ] `Post.attachments: IAttachment[]` — Mongoose schema update, non-breaking (defaults to `[]`).
- [ ] `messages.attachments JSONB NOT NULL DEFAULT '[]'` — PG migration + update `Message.deleteOlderThan` / create / query paths.
- [ ] Upload route returns the structured object (not just a URL).
- [ ] Frontend: post composer + message composer use `attachments[]` field on submit.
- [ ] **Backfill migration** — script that walks existing posts/messages, finds inline URLs matching `/api/uploads/...`, creates `Attachment` rows, embeds structured references in-place. Idempotent, batched.

### Phase 3 — GCS driver (one PR)

**Goal:** Cloud instance uses GCS. Self-hosted unaffected.

- [ ] `backend/services/objectStore/drivers/gcs.ts` — V4 signed URLs, @google-cloud/storage SDK.
- [ ] Helm values: `objectStore.driver`, `objectStore.bucket`. Update `values-dev.yaml` / `values-prod.yaml`.
- [ ] GCP: create buckets `commonly-dev-media` + `commonly-media`, IAM SA with `storage.objectAdmin` scoped to bucket only. Store SA key via ESO → K8s secret `object-store-creds`.
- [ ] Route layer: when driver reports `signedUrls: true`, respond with `302` on GET (or `{url}` JSON if `Accept: application/json`).
- [ ] Deploy to dev; migrate existing `File` buffers to GCS via a one-time script (optional — leaving them in Mongo works, they just never get served until requested, and can migrate lazy-on-access).

### Phase 4 — Thumbnails + GC (one PR)

- [ ] `sharp` added as dep; sync thumbnail generation during upload for images ≤2 MB.
- [ ] Async thumbnail queue (reuses `agentEventService`-style queue?) for larger images + video.
- [ ] Nightly GC cron in `pgRetentionService` sibling: walk `Attachment` where `ref_count == 0 AND last_referenced_at < NOW() - 24h`, delete from driver + DB.

### Phase 5 — `filesystem` + `s3` drivers (optional PRs)

- [ ] `filesystem` driver + Helm `persistence` values.
- [ ] `s3` driver (works for AWS S3, MinIO, Cloudflare R2).
- [ ] MinIO subchart as optional Helm dependency for self-hosters who want everything local.

### Phase 6 — Hardening (deferred)

- [ ] Pre-signed client-direct uploads (`POST /api/media/presigned-put`).
- [ ] CDN in front of GCS bucket (Cloud CDN).
- [ ] ClamAV scan for non-image uploads.
- [ ] SafeSearch classifier for images.
- [ ] Rate limiting per-user on uploads.

---

## Open questions

- **Should agent runtimes be able to upload?** If yes, `POST /api/media` needs to accept the `agentRuntimeAuth` middleware as well as the user `auth` middleware. First-party use case: an agent generates a chart image and posts it to a pod. **Probably yes** — and CAP should include attachment upload in the join protocol.
- **Profile picture migration.** `User.profilePicture` is currently a URL string. Phase 2 wants to move this to `IAttachment` too. Backward-compat wrinkle: many clients read `user.profilePicture` and expect a URL. Resolve with a virtual getter `profilePictureUrl` that collapses `profilePicture.storage_key → signed URL` on serialize.
- **Image orientation / EXIF stripping.** Phone images often carry EXIF rotation metadata. Strip on upload (privacy + consistent rendering) via `sharp`. Uncontroversial; note in Phase 4.
- **Cross-pod forwarding.** If a user forwards a message with an attachment to a pod they're in but the attachment came from a pod they're not, do we allow read? Current stance: attachment access is granted by presence in **any** pod/post that references it. A malicious forward to a public pod effectively leaks; this is consistent with how other chat platforms behave.
- **Retention on attachments.** Should attachments follow message retention (see ADR-001-ish `pgRetentionService`)? Yes — when a message is deleted by retention, decrement `ref_count`. Already covered by the GC pass.

---

## Decision log

- 2026-04-14: Draft created. Current `File`-inline-in-Mongo design identified as the primary pain point during a Cloud SQL (Aiven) disk-full incident that surfaced the related "LiteLLM spend logs unbounded" issue. Fix for that incident is separate (PR #185 fix + `maximum_spend_logs_retention_period: 7d`) but revealed that our data-volume blind spots are worth auditing broadly — this ADR is the attachments slice.
