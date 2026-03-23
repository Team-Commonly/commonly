---

name: database
description: Database management context for MongoDB, PostgreSQL, dual-database architecture, and data synchronization. Use when working on database schemas, queries, or migrations.
last_updated: 2026-03-22
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

### PostgreSQL `users` table — `is_bot` column (added 2026-03-08)

```sql
-- Added to backend/config/schema.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;
```

**Why**: `syncUserToPostgreSQL` (in `agentIdentityService.js`) stores human-readable display names ("Liz", "Tarik") in `users.username` for UX. Without a separate flag, `getRecentMessages` in `agentMessageService.js` had to use a fragile `username.startsWith('openclaw-')` heuristic to detect agent messages. Agent display names don't start with "openclaw-", so those messages appeared as `isBot: false` — agents were replying to each other's narration.

**Change set**:
- `backend/config/schema.sql` — `is_bot BOOLEAN DEFAULT false` column + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration guard
- `backend/services/agentIdentityService.js` `syncUserToPostgreSQL` — writes `is_bot = user.isBot` alongside display name
- `backend/models/pg/Message.js` `findByPodId` — selects `u.is_bot` in the JOIN
- `backend/services/agentMessageService.js` `getRecentMessages` — uses `msg.is_bot` from the PG join; falls back to username heuristic only for rows synced before the column existed

**Backfill**: Any existing PG user rows for agent accounts have `is_bot = false` until `syncUserToPostgreSQL` is called again (happens automatically on next heartbeat or reprovision).

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

## PostgreSQL (Aiven) — TLS / CA Cert (2026-03-22)

- **Host**: `YOUR_PG_HOST:25450`
- **SSL required**: Aiven uses a self-signed Project CA. Must set `PG_SSL_CA_PATH=/app/certs/ca.pem`.
- **CA cert storage**: GCP Secret Manager key `commonly-pg-ca-cert` → ESO ExternalSecret `postgres-ca-cert` → mounted at `/app/certs/ca.pem` in backend pod.
- **Template**: `k8s/helm/commonly/templates/configmaps/backend-config.yaml` — uses ESO when `externalSecrets.enabled: true` (do NOT use file-based `configs/ca.pem`; `*.pem` is gitignored and will be empty).
- **If CA cert is missing/empty**: backend logs `self-signed certificate in certificate chain` → PG skipped → messages fall back to MongoDB.
- **Extracting the cert** (if ever needed again): `openssl s_client -connect YOUR_PG_HOST:25450 -starttls postgres -showcerts 2>/dev/null` → second cert in chain is the Aiven Project CA (issuer = subject).
- **MongoDB fallback**: `backend/config/db-pg.js` skips pool init when `PG_HOST` is empty; `messageController.js` and `server.js` catch PG errors and fall back to MongoDB.

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
