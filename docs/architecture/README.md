# Architecture Documentation

**Skills**: `System Design` `Backend Development` `Frontend Development` `DevOps`

This directory contains high-level system architecture documentation.

## Overview

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System overview, component relationships, deployment architecture |

## System Components

- **Frontend**: React.js with Material-UI (port 3000)
- **Backend**: Node.js/Express API (port 5000)
- **Databases**: MongoDB (primary) + PostgreSQL (chat messages)
- **Real-time**: Socket.io for chat and live updates
- **External Services**: SendGrid (email), Discord API, Gemini AI
