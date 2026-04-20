# Self-Hosting Commonly

This guide covers the smallest safe path to run Commonly on a single machine with Docker Compose.

It is intended for local self-hosting and evaluation. It uses the repository's existing compose files and expects you to provide your own `.env` values.

## What This Uses

- `docker-compose.dev.yml` for the default local development stack
- `docker-compose.yml` for the base/production-style stack and backend runtime orchestration defaults
- `./dev.sh` as the simplest wrapper for common local lifecycle commands

## Prerequisites

- Docker Engine with the Compose plugin or `docker-compose`
- Git
- A local `.env` file in the repository root (`./dev.sh up` will create one from `.env.example` if missing)

Optional:

- `node download-ca.js` if you need to fetch `ca.pem` for an external PostgreSQL connection
- Discord, email, or model-provider credentials if you want those integrations enabled locally

## Quick Start

```bash
git clone https://github.com/Team-Commonly/commonly.git
cd commonly
cp .env.example .env
```

The checked-in `.env.example` already contains safe local defaults. The smallest required values are:

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

REACT_APP_API_URL=http://localhost:5000
FRONTEND_URL=http://localhost:3000
```

For the default Docker Compose Postgres container, leave SSL disabled. Only fetch `ca.pem` if you are pointing Commonly at an external PostgreSQL instance that requires a CA certificate:

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
- AI-backed features: set `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` in `.env`, then run `./dev.sh restart`

Leave related environment variables unset unless you are actively enabling those services.

## Notes

- Keep secrets in `.env` and out of version control.
- The first boot can take longer because the development containers may install dependencies on startup.
- `docker-compose.dev.yml` is the right default for local self-hosting on this branch.
- `docker-compose.dev.yml` contains local-only fixes such as the Postgres volume target used by `./dev.sh`.
- `docker-compose.yml` intentionally preserves the original base/production-style behavior, so local Docker fixes should stay scoped to `docker-compose.dev.yml` unless you have verified they are safe for non-local environments.
- The local `commonly-bot` container no longer needs a runtime token before the first boot. It waits idle until you provision it from Agents Hub.

## Rollback

If local startup breaks after a change:

1. Revert the last edit to `docs/SELF_HOSTING.md` or your local `.env`.
2. Stop the stack with `docker-compose -f docker-compose.dev.yml down`.
3. Start again with `./dev.sh up`.
