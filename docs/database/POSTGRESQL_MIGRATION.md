# PostgreSQL Message Storage Migration

## Overview

Commonly has been updated to use **PostgreSQL as the default storage for all chat messages**, while maintaining MongoDB for user management and pod metadata. This document describes the current implementation and key changes.

## Current Architecture

### Database Roles

| Component | MongoDB | PostgreSQL |
|-----------|---------|------------|
| **Users** | ✅ Primary (auth, profiles) | 🔄 Sync (for message joins) |
| **Pods** | ✅ Primary (metadata, membership) | 🔄 Sync (for chat functionality) |
| **Messages** | ❌ Fallback only | ✅ **Primary Storage** |
| **Posts** | ✅ Primary | ❌ Not used |

### Message Flow

```
1. User sends message
   ↓
2. Check pod membership (MongoDB)
   ↓
3. Store message (PostgreSQL) 
   ↓
4. Broadcast via Socket.io
   ↓
5. Retrieve messages (PostgreSQL)
```

## Key Implementation Details

### Controllers Updated

- **`messageController.js`**: Now uses PostgreSQL for all message operations
  - `getMessages()`: Retrieves from PostgreSQL with MongoDB membership check
  - `createMessage()`: Stores in PostgreSQL after MongoDB authorization
  - `deleteMessage()`: Deletes from PostgreSQL with MongoDB permission check

### Socket.io Integration

- **Real-time messaging**: Uses PostgreSQL for storage with MongoDB for authorization
- **Fallback mechanism**: Falls back to MongoDB if PostgreSQL fails
- **Consistent flow**: Both manual and socket messages use same PostgreSQL storage

### Agent Integration

- **AgentMessageService**: Posts agent messages into PostgreSQL when available
- **User synchronization**: Agent users are auto-synced to PostgreSQL users table
- **One-time sync**: Efficient checking to avoid unnecessary user syncing

## Message Ordering

Messages are stored and retrieved in **chronological order** (oldest first):
- PostgreSQL query: `ORDER BY created_at ASC`
- Frontend display: Shows messages in chronological conversation flow

## Environment Configuration

### PostgreSQL Connection
```env
PG_HOST=commonly-psql-commonly.b.aivencloud.com
PG_PORT=25450
PG_USER=avnadmin
PG_PASSWORD=AVNS_5J5VqE75lSHGkOdYoOK
PG_DATABASE=defaultdb
PG_SSL_CA_PATH=/app/ca.pem
```

### Development vs Production
- **Development**: Uses external PostgreSQL with file mounting for live reloading
- **Production**: Same PostgreSQL with optimized container builds

## Database Schema

### PostgreSQL Tables

```sql
-- Messages (primary storage)
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  pod_id VARCHAR(24) REFERENCES pods(id),
  user_id VARCHAR(24) NOT NULL,
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Users (synchronized from MongoDB)
CREATE TABLE users (
  _id VARCHAR(24) PRIMARY KEY,
  username VARCHAR(100) NOT NULL,
  profile_picture TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Pods (synchronized from MongoDB)
CREATE TABLE pods (
  id VARCHAR(24) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL,
  created_by VARCHAR(24) NOT NULL
);
```

## Testing the Migration

### Verification Steps

1. **Message Persistence**: Send message → refresh page → message should persist
2. **Message Ordering**: Messages appear in chronological order (oldest first)
3. **Bot Messages**: Discord integration messages show the Commonly Bot agent user (`commonly-bot`) instead of "Unknown User"
4. **Real-time Updates**: Messages appear immediately via Socket.io
5. **Fallback**: System gracefully falls back to MongoDB if PostgreSQL fails

### Development Commands

```bash
# Restart environment with changes
./dev.sh restart

# Check PostgreSQL connection
./dev.sh logs backend | grep PostgreSQL

# Test message persistence
# 1. Send message in pod
# 2. Refresh browser
# 3. Verify message persists
```

## Troubleshooting

### Common Issues

1. **"Unknown User" in messages**
   - **Cause**: User not synchronized to PostgreSQL
   - **Fix**: User sync happens automatically on first message

2. **Messages disappear after refresh**
   - **Cause**: PostgreSQL connection failed, fell back to MongoDB
   - **Check**: Backend logs for PostgreSQL connection errors

3. **Message order reversed**
   - **Cause**: PostgreSQL query ordering mismatch
   - **Fix**: Ensure `ORDER BY created_at ASC` in Message model

### Logs to Monitor

```bash
# Check PostgreSQL connection
✅ PostgreSQL connected successfully
✅ PostgreSQL routes registered for chat functionality

# Check message creation
✅ Discord summary message created in PostgreSQL
✅ Commonly Bot agent user synchronized to PostgreSQL: commonly-bot

# Check for errors
❌ PostgreSQL connection error: [error details]
❌ SQL Error in Message.create: [error details]
```

## Future Considerations

### Performance Optimizations
- **Indexing**: Optimize PostgreSQL indexes for message queries
- **Connection Pooling**: Monitor PostgreSQL connection pool usage
- **Caching**: Consider Redis for frequently accessed messages

### Migration Completion
- **Data Migration**: Migrate existing MongoDB messages to PostgreSQL
- **Cleanup**: Remove MongoDB message fallback code
- **Monitoring**: Add PostgreSQL health checks and metrics

## Related Files

### Controllers
- `backend/controllers/messageController.js` - Message CRUD operations
- `backend/controllers/podController.js` - Pod management (dual database)

### Models
- `backend/models/pg/Message.js` - PostgreSQL message model
- `backend/models/pg/Pod.js` - PostgreSQL pod reference model (reference-only; MongoDB `Pod` is authoritative)
- `backend/models/Message.js` - MongoDB message model (fallback)

### Services
- `backend/services/agentMessageService.js` - Agent message handling
- `backend/server.js` - Socket.io message routing

### Configuration
- `backend/config/db-pg.js` - PostgreSQL connection
- `backend/config/schema.sql` - PostgreSQL schema definition
- `docker-compose.dev.yml` - Development environment setup
