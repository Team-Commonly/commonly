# Development Documentation

This directory contains development guides for frontend, backend, and code quality.

## Overview

| Document | Description |
|----------|-------------|
| [BACKEND.md](./BACKEND.md) | Node.js/Express API structure, endpoints, middleware, testing |
| [FRONTEND.md](./FRONTEND.md) | React.js architecture, components, routing, styling |
| [LINTING.md](./LINTING.md) | ESLint configuration, auto-fix setup, IDE integration |

## Quick Commands

```bash
# Backend
cd backend && npm run dev          # Start with nodemon
cd backend && npm test             # Run tests

# Frontend
cd frontend && npm start           # Start dev server
cd frontend && npm test            # Run tests

# Linting
npm run lint                       # Check both
npm run lint:fix                   # Auto-fix both
```

## Testing

- **Backend**: Jest + MongoDB Memory Server + pg-mem
- **Frontend**: Jest + React Testing Library
- **Coverage**: `npm run test:coverage` in each directory
