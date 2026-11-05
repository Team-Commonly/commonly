# Database Schema Documentation

This document details the database schemas used in the Commonly application, covering both MongoDB and PostgreSQL.

## Dual Database Architecture

Commonly uses a dual database architecture:

1. **MongoDB**: Used for user data, posts, and general application data that benefits from a flexible schema
2. **PostgreSQL**: Used for chat functionality (pods and messages) where relational integrity is important

This approach allows us to leverage the strengths of each database type:
- MongoDB's flexibility for evolving data models
- PostgreSQL's ACID compliance and relational capabilities for chat functionality

## MongoDB Schemas

### User Schema

```javascript
const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 8
  },
  profilePicture: {
    type: String,
    default: 'default-profile.png'
  },
  bio: {
    type: String,
    maxlength: 200,
    default: ''
  },
  location: {
    type: String,
    default: ''
  },
  interests: [{
    type: String,
    trim: true
  }],
  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  notifications: [{
    type: {
      type: String,
      enum: ['like', 'comment', 'follow', 'message'],
      required: true
    },
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post'
    },
    message: {
      type: String
    },
    isRead: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  isVerified: {
    type: Boolean,
    default: false
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});
```

### Post Schema

```javascript
const PostSchema = new mongoose.Schema({
  podId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pod', default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String, default: '' },
  category: { type: String, default: 'General' },
  source: {
    type: { type: String, default: 'user' }, // user | pod | external
    provider: { type: String, default: 'internal' },
    externalId: { type: String, default: null },
    url: { type: String, default: null },
    author: { type: String, default: null },
    authorUrl: { type: String, default: null },
    channel: { type: String, default: null }
  },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  tags: [{ type: String }],
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
```

### Pod Schema (MongoDB, Authoritative)

Pods and membership checks are authoritative in MongoDB. PostgreSQL stores references for chat joins.

```javascript
const PodSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: {
      type: String,
      enum: ['chat', 'study', 'games', 'agent-ensemble'],
      default: 'chat',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
```

Agent Ensemble Pods (`type: 'agent-ensemble'`) store additional configuration in `pod.agentEnsemble`
for multi-agent orchestration (participants, stop conditions, schedules, and human participation).

### PodAsset Schema (MongoDB, Pod Memory Index)

PodAssets provide indexed pod memory for agents and context assembly. They include summaries, integration windows, and LLM-generated skills.

```javascript
const PodAssetSchema = new mongoose.Schema(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true, index: true },
    type: {
      type: String,
      enum: [
        'summary',
        'integration-summary',
        'skill',
        'memory',
        'daily-log',
        'message',
        'thread',
        'file',
        'doc',
        'link',
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: '' },
    tags: { type: [String], default: [], index: true },
    sourceType: { type: String, default: null },
    sourceRef: {
      summaryId: { type: Schema.Types.ObjectId, ref: 'Summary', default: null },
      integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', default: null },
      messageId: { type: String, default: null },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdByType: {
      type: String,
      enum: ['system', 'user', 'agent'],
      default: 'system',
      index: true,
    },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  },
  { timestamps: true },
);
```

Operational notes:
- Chat summarization and integration buffer summarization persist PodAssets.
- `GET /api/pods/:id/context` can synthesize LLM skill docs and upsert them as `PodAsset(type='skill')`.
- Agent-scoped memory uses `metadata.scope = 'agent'` with `metadata.agentName` and `metadata.instanceId`.
- Pod-shared memory uses `metadata.scope = 'pod'`. Assets without `metadata.scope` are treated as shared.

## PostgreSQL Schema

### Pods Table

```sql
CREATE TABLE pods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL CHECK (type IN ('chat', 'study', 'games', 'agent-ensemble')),
  created_by VARCHAR(100) NOT NULL,  -- MongoDB ObjectId as string
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pods_type ON pods(type);
CREATE INDEX idx_pods_created_by ON pods(created_by);
```

### Pod Members Table

```sql
CREATE TABLE pod_members (
  id SERIAL PRIMARY KEY,
  pod_id INTEGER REFERENCES pods(id) ON DELETE CASCADE,
  user_id VARCHAR(100) NOT NULL,  -- MongoDB ObjectId as string
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pod_id, user_id)
);

CREATE INDEX idx_pod_members_pod_id ON pod_members(pod_id);
CREATE INDEX idx_pod_members_user_id ON pod_members(user_id);
```

MVP roles are derived instead of stored:
- **Admin** is the pod creator (`created_by` in Postgres, `createdBy` in Mongo).
- **Member** is any user present in `pod_members`.
- **Viewer** is read-only access and is enforced at the application layer (not persisted yet).

### Messages Table

```sql
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  pod_id INTEGER REFERENCES pods(id) ON DELETE CASCADE,
  user_id VARCHAR(100) NOT NULL,  -- MongoDB ObjectId as string
  content TEXT NOT NULL,
  message_type VARCHAR(50) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'file', 'system')),
  attachment VARCHAR(255),
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_pod_id ON messages(pod_id);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_sent_at ON messages(sent_at);
```

### Read Receipts Table

```sql
CREATE TABLE message_read_receipts (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id VARCHAR(100) NOT NULL,  -- MongoDB ObjectId as string
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, user_id)
);

CREATE INDEX idx_read_receipts_message_id ON message_read_receipts(message_id);
CREATE INDEX idx_read_receipts_user_id ON message_read_receipts(user_id);
```

## Data Relationships

### Cross-Database Relationships

Since the application uses two separate databases, we maintain references between them:

1. **User References**:
   - In PostgreSQL, user IDs from MongoDB are stored as strings in the `user_id` columns
   - This allows us to link chat messages and pod memberships to user accounts

2. **Pod References**:
   - MongoDB is authoritative for pods and membership via the `Pod` collection
   - PostgreSQL stores pod and membership references for chat joins and integrity
   - Pod memory and agent-facing context are indexed in MongoDB via `PodAsset`

### MongoDB Relationships

MongoDB relationships use the `ref` property to create references between documents:

- **User-Post Relationship**: One-to-many, with posts containing a reference to the user
- **Post-Comment Relationship**: One-to-many, with comments embedded in post documents
- **User-Follower Relationship**: Many-to-many, with user IDs stored in arrays

### PostgreSQL Relationships

PostgreSQL uses traditional foreign key constraints:

- **Pod-Member Relationship**: One-to-many, using the `pod_id` foreign key
- **Pod-Message Relationship**: One-to-many, using the `pod_id` foreign key
- **Message-ReadReceipt Relationship**: One-to-many, using the `message_id` foreign key

## Indexes

### MongoDB Indexes

```javascript
// User indexes
UserSchema.index({ username: 1 });
UserSchema.index({ email: 1 });

// Post indexes
PostSchema.index({ user: 1 });
PostSchema.index({ createdAt: -1 });
PostSchema.index({ tags: 1 });

// Pod indexes
PodSchema.index({ createdBy: 1 });
PodSchema.index({ members: 1 });
PodSchema.index({ updatedAt: -1 });

// PodAsset indexes
PodAssetSchema.index({ podId: 1, createdAt: -1 });
PodAssetSchema.index({ podId: 1, tags: 1, createdAt: -1 });
PodAssetSchema.index(
  { title: 'text', content: 'text', tags: 'text' },
  { weights: { title: 5, tags: 4, content: 1 } },
);
```

### Pattern: an atomic "at most N open" cap and a unique open identity

`ApprovalAction` (F184) shows the pattern. Use it when a rule like "at most 3 open per seat
and pod" or "one open row per identical request" has to hold under concurrent writers.

- **Hold the cap with slots, not a counter.** Each open row stores a slot number from 0 to
  N-1, and a partial unique index on `(scope…, slot)` covers only open rows. A creator tries
  slot 0, then 1, and so on. A duplicate-key error means the slot is taken. A row frees its
  slot by leaving the open status, in the same write that closes it. A counter document needs
  a decrement on every closing path, and one missed path leaks a slot for good. Slots have
  nothing to release.
- **Identity gets its own index.** Identical concurrent callers walk the slots in the same
  order and usually collide on the same slot. They don't when a lower slot frees mid-race, so
  a second partial unique index on the identity key is what guarantees one open row.
- **Decide which index refused by reading the data, not the error.** FerretDB can answer a
  lost race with a code-1 error that has no `keyPattern` (ADR-034).
- **Adding a unique index to a collection that already has data:** make it partial on a field
  only new code writes (`toolCallSlot: { $exists: true }`). Older rows, including any existing
  duplicates, are never indexed, so the boot-time `autoIndex` build cannot fail on them.
  Partial filters use equality and `$exists` only; FerretDB refuses `$in` and other operators
  there (ADR-034).

### Pattern: a terminal transition whose side effects can be retried

`ApprovalAction` expiry (F202) shows the pattern. Use it when one conditional write closes a
row and several side effects (an audit row, a card, an event) must follow it, and a waiter
depends on the last of them.

- **The flip stays the decision.** `findOneAndUpdate({ _id, status: 'flagged' }, { status:
  'expired', … })` decides who expires the row. The side effects come after it and cannot
  undo it.
- **Steps run independently; a marker is written last.** The trail, the wake and the card each
  run whether or not another failed, so a failing card never holds back the wake the parked
  runs wait on. `expirySideEffectsDoneAt` is set only when all of them succeeded; otherwise the
  attempt throws one error naming every failed step. A row that is `expired` without the marker
  crashed or failed midway.
- **Opt rows in with the flip.** The same flip writes `expiryRetryCount: 0`. The retry selects
  `expiryRetryCount: { $lt: MAX_EXPIRY_RETRIES }`, which a missing field never matches, so rows
  closed before F202 are never re-run.
- **Backoff, and a lease from it.** A row is due once `max(resolvedAt, expiryRetryClaimedAt)` is
  older than `EXPIRY_RETRY_GRACE_MS * 2^expiryRetryCount` (1 min, doubling, at most an hour per
  step); `expiryRetryDueAt` computes it. The claim is one conditional write on the count and the
  claim time the sweeper read, stamping a new `expiryRetryClaimedAt` and bumping the count: a
  sweeper that read the same row loses the claim, and one that reads it afterwards finds it not
  yet due. An attempt slower than its wait can overlap the next one; that is tolerable only
  because every step is safe to repeat. `MAX_EXPIRY_RETRIES` (11) spans about six hours, then the
  sweep logs an error and stops selecting the row.
- **An operator way back from the cap.** `backend/scripts/retry-capped-approval-expiries.ts`
  lists capped rows (expired, no marker, count at the cap) on a dry run, and with an explicit
  `--apply` resets their count to 0 so the next sweep retries them. It refuses any other argument.
- **Every side effect must be safe to repeat.** The trail row's id is derived from the approval
  and the reason, so a second insert hits the primary key. The record dedupes on its event key.
  The card rewrites the same payload. The wake is sent at least once, with a narrow overlap
  window. An attempt takes a lease on it (`expiryEventClaimedAt`, set by a conditional write while
  `expiryEventSentAt` is null and the lease is unset or older than `EXPIRY_WAKE_CLAIM_LEASE_MS`,
  2 min), enqueues, then stamps `expiryEventSentAt`. A failed enqueue clears the lease only if it
  is still that attempt's. A crashed sender's lease expires and a later retry sends. While another
  attempt holds a fresh lease the step fails, so the row is not marked done before the wake is
  known sent. A crash after the send but before the stamp is covered by an existing
  `approval.resolved` event for the approval; the overlap window is a send that stalls past its
  lease, or that crash found after the event row is collected (about 30 minutes). The stamp
  itself does not depend on `AgentEvent` retention.

Fields, on `tool_call` rows only: `expiryRetryCount` (Number), `expiryRetryClaimedAt` (Date),
`expirySideEffectsDoneAt` (Date), `expiryEventSentAt` (Date) and `expiryEventClaimedAt` (Date). Index `tool_call_expiry_retry`:
`{ status, actionType, resolvedAt }`, partial on `expiryRetryCount: { $exists: true }`.

### PostgreSQL Indexes

PostgreSQL indexes are defined in the table creation statements above, focusing on:

- Foreign key columns
- Timestamp columns for chronological ordering
- Fields commonly used in WHERE clauses

## Database Migrations

### MongoDB

For MongoDB, we use a code-based migration approach:

1. Migration scripts are stored in `backend/migrations/mongodb`
2. Each migration has an `up()` and `down()` method
3. Migrations are versioned and tracked in a `migrations` collection

### PostgreSQL

For PostgreSQL, we use SQL migration files:

1. Migration files are stored in `backend/migrations/postgres`
2. Migrations are applied in order based on their filename prefix (e.g., `001_create_pods.sql`)
3. A migrations table tracks which migrations have been applied

## Fallback Mechanism

If PostgreSQL is unavailable, the application can fall back to using MongoDB for all functionality:

1. A backup `pods` and `messages` collection in MongoDB mirrors the PostgreSQL schema
2. The application checks PostgreSQL availability on startup
3. If PostgreSQL is unavailable, it routes all chat operations to MongoDB

## Performance Considerations

### MongoDB

- Use of sparse indexes for fields that aren't present in all documents
- Embedding comments directly in posts to reduce query complexity
- Pagination implemented using the `_id` field for efficient cursor-based pagination
- **"Newest X per install" is one seek per install, never `$match` → `$sort` → `$group` + `$first`.**
  That shape reads every matching document to keep one per group, so its cost grows with
  history rather than with installs. A field it filters on but no index holds (here `type`)
  turns each match into a FETCH. On 11-04 the pod roster's last-heartbeat read fetched a
  week of every delivered event its seats had in every pod (333k documents for a 25-seat
  pod in the test) and the route drew 504s at nginx's 5 s limit (TASK-774). Use
  `services/newestPerInstall.ts`: one `$match` → `$sort` → `$limit: 1` branch per install,
  joined with `$unionWith`, on an index with the match's equality fields followed by the
  sorted field. `__tests__/service/podAgents.rosterLatency.realDb.test.js` pins the roster
  through Mongo's own profiler (keys and documents examined), which a slow runner cannot
  move.

### PostgreSQL

- Appropriate indexing on foreign keys and frequently queried fields
- Partitioning of the messages table by pod_id for large deployments
- Query optimization using EXPLAIN ANALYZE

## Data Validation

### MongoDB

Data validation is performed at multiple levels:

1. **Schema-level validation** using Mongoose schemas
2. **Application-level validation** using express-validator
3. **Database-level validation** using MongoDB validation rules

### PostgreSQL

Data validation is performed at multiple levels:

1. **Schema-level validation** using CHECK constraints and foreign keys
2. **Application-level validation** using express-validator
3. **Database-level validation** through triggers and constraints

## Backup Strategy

1. **MongoDB Backups**:
   - Daily snapshots using MongoDB's native tools
   - Replication for high availability

2. **PostgreSQL Backups**:
   - Daily logical backups using pg_dump
   - Point-in-time recovery using WAL archiving
   - Replication for high availability 
