# Database Documentation

**Skills**: `Database Management` `MongoDB` `PostgreSQL` `Schema Design`

This directory contains documentation for the dual-database architecture (MongoDB + PostgreSQL).

## Overview

| Document | Description |
|----------|-------------|
| [DATABASE.md](./DATABASE.md) | MongoDB & PostgreSQL schemas, relationships, indexes, migrations |
| [POSTGRESQL_MIGRATION.md](./POSTGRESQL_MIGRATION.md) | PostgreSQL message storage implementation, migration guide |

## Database Architecture

- **MongoDB**: Users, posts, pod metadata, authentication (primary)
- **PostgreSQL**: Chat messages, user/pod references for joins (default for chat)
- **Synchronization**: Automatic user/pod sync between databases
- **Fallback**: Graceful fallback to MongoDB if PostgreSQL unavailable
