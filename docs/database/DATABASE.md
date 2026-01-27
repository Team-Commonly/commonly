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
  content: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  media: {
    type: String
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  tags: [{
    type: String,
    trim: true
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
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
      enum: ['chat', 'study', 'games'],
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

## PostgreSQL Schema

### Pods Table

```sql
CREATE TABLE pods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL CHECK (type IN ('chat', 'study', 'game')),
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
  role VARCHAR(50) DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pod_id, user_id)
);

CREATE INDEX idx_pod_members_pod_id ON pod_members(pod_id);
CREATE INDEX idx_pod_members_user_id ON pod_members(user_id);
```

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
```

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
