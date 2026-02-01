---
name: database
description: Database management context for MongoDB, PostgreSQL, dual-database architecture, and data synchronization. Use when working on database schemas, queries, or migrations.
---

# Database Management

**Technologies**: MongoDB, PostgreSQL, Mongoose, node-postgres

## Required Knowledge
- MongoDB schema design and Mongoose ODM
- PostgreSQL tables, indexes, constraints
- Dual-database architecture patterns
- Database migrations
- Data synchronization strategies

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [DATABASE.md](../../../docs/database/DATABASE.md) | Schemas, relationships, indexes, migrations |
| [POSTGRESQL_MIGRATION.md](../../../docs/database/POSTGRESQL_MIGRATION.md) | Message storage, dual-DB architecture |
| [ARCHITECTURE.md](../../../docs/architecture/ARCHITECTURE.md) | Database roles, sync strategy |

## Database Roles

| Component | MongoDB | PostgreSQL |
|-----------|---------|------------|
| Users | Primary | Sync |
| Pods | Primary | Sync |
| Messages | Fallback | Primary |
| PodAssets (memory) | Primary | Not used |
| Posts | Primary | Not used |

## Pod Memory Model

- Indexed pod memory is stored in MongoDB via `PodAsset`.
- `PodAsset` includes summaries, integration summaries, and LLM-generated skills (`type='skill'`).
- Pod context assembly (`GET /api/pods/:id/context`) reads PodAssets and can upsert skills.

## Key Models

### MongoDB (Mongoose)
```javascript
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  pods: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Pod' }]
});
```

### PostgreSQL
```sql
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  pod_id VARCHAR(24) NOT NULL,
  user_id VARCHAR(24) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_messages_pod ON messages(pod_id);
```

## Sync Strategy
```javascript
// Auto-sync user to PostgreSQL when needed
async function ensureUserInPostgres(mongoUserId) {
  const exists = await PGUser.findById(mongoUserId);
  if (!exists) {
    const mongoUser = await User.findById(mongoUserId);
    await PGUser.create(mongoUser);
  }
}
```
