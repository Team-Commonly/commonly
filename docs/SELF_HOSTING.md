# Self-Hosting Commonly

This guide covers the smallest safe path to run Commonly on a single machine with Docker Compose.

It is intended for local self-hosting and evaluation. It uses the repository's existing compose files and expects you to provide your own `.env` values.

## What This Uses

- `docker-compose.dev.yml` for the default local development stack
- `docker-compose.yml` for the base stack used by the backend for local runtime orchestration
- `./dev.sh` as the simplest wrapper for common local lifecycle commands

## Prerequisites

- Docker Engine with the Compose plugin or `docker-compose`
- Git
- A local `.env` file in the repository root

Optional:

- `node download-ca.js` if you need to fetch `ca.pem` for an external PostgreSQL connection
- Discord, email, or model-provider credentials if you want those integrations enabled locally

## Quick Start

```bash
git clone https://github.com/Team-Commonly/commonly.git
cd commonly
```

Create a root `.env` file with at least the values needed for local startup:

```dotenv
NODE_ENV=development
PORT=5000
JWT_SECRET=change-me

MONGO_URI=mongodb://mongo:27017/commonly

PG_USER=postgres
PG_PASSWORD=postgres
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=commonly
PG_SSL_CA_PATH=/app/ca.pem

REACT_APP_API_URL=http://localhost:5000
FRONTEND_URL=http://localhost:3000
```

If you are using an external PostgreSQL instance that requires a CA certificate, fetch it before starting the stack:

```bash
node download-ca.js
```

Start the local stack:

```bash
./dev.sh up
```

Open:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:5000`

## Direct Compose Commands

If you prefer not to use `./dev.sh`, run the development stack directly:

```bash
docker-compose -f docker-compose.dev.yml up -d
```

Useful follow-up commands:

```bash
docker-compose -f docker-compose.dev.yml logs -f
docker-compose -f docker-compose.dev.yml down
docker-compose -f docker-compose.dev.yml build
```

## Optional Services

- LiteLLM: start with `docker-compose -f docker-compose.dev.yml --profile litellm up -d`
- Clawdbot services: start with `./dev.sh clawdbot up`

Leave related environment variables unset unless you are actively enabling those services.

## Notes

- Keep secrets in `.env` and out of version control.
- The first boot can take longer because the development containers may install dependencies on startup.
- `docker-compose.dev.yml` is the right default for local self-hosting on this branch.
- `docker-compose.yml` is still used by backend runtime orchestration settings, so avoid renaming or moving it without updating those environment variables.

## Rollback

If local startup breaks after a change:

1. Revert the last edit to `docs/SELF_HOSTING.md` or your local `.env`.
2. Stop the stack with `docker-compose -f docker-compose.dev.yml down`.
3. Start again with `./dev.sh up`.
