
# Codex Agent Instructions

This repository is split into a backend API and a frontend React
application.  Everything is containerised via `docker-compose` for local
development.

## Project structure

- `backend/` – Node.js/Express API. Uses MongoDB and PostgreSQL and has
  its own Jest test suite.
- `frontend/` – React application bootstrapped with `react-scripts`.
- `docs/` – Detailed architecture and development docs.
- `docs/design/` – Design proposals for new features.
- `docker-compose.yml` – Spins up the full stack locally.
- `package.json` in the repo root – exposes lint scripts that call into
  each package.

## Architecture overview

Commonly follows a client–server model. The backend exposes a REST API
with Socket.io for real-time features. Data is stored in MongoDB (general
app data) and PostgreSQL (chat). The frontend communicates with the API
and renders the user interface using React and Material-UI. See the
documents in `docs/` for full details.

## Reading documentation

Always read the documentation in `docs/` before diving into other
directories. The following files outline the architecture, API endpoints
and development conventions:

- `ARCHITECTURE.md`
- `BACKEND.md`
- `FRONTEND.md`
- `DATABASE.md`
- `DEPLOYMENT.md`
- `LINTING.md`
- Integration providers live in `backend/integrations/providers/` (discord, slack, groupme, telegram).
- Webhook routes for integrations are under `/api/webhooks/<provider>/<integrationId>`.
- `whatsapp/WHATSAPP_INTEGRATION_PLAN.md` (for WhatsApp work)
- `integrations/INTEGRATION_CONTRACT.md` (for any new external integration)
- `integrations/COMMONLY_APP_PLATFORM.md` (for app/installation flow like GitHub Apps)
- `slack/README.md`, `google-chat/README.md`, `groupme/README.md` (integration notes)

Design documents in `docs/design/` provide additional details for upcoming
features. Review them and add new design docs when planning major
functionality.

Use these documents and any relevant design docs as a reference when
implementing new features or updating existing code.
When you add or modify features, update the relevant docs and this AGENTS file so future agents have accurate guidance.

## Running tests

- **Backend**: run `npm test` from the `backend` directory.
- **Frontend**: run `npm test` from the `frontend` directory.

## Running lint

Run `npm lint` from the repository root. This invokes the lint scripts for both backend and frontend.

## Files to ignore

Skip dependency and build directories when browsing the repository:

- `node_modules/`
- `build/` or `dist/`
- `.env`
- `.vscode/` or `.idea/`

These folders are generated artifacts or configuration files that aren't

## Workflow

When modifying code in either package:
1. Run `npm lint` at the repo root.
2. Run `npm test` in the affected package(s).

 - Always add or update tests when introducing new features. This applies to both the backend and the frontend. Prioritise expanding overall test coverage.
These commands require no additional setup other than installing dependencies (already included in the repository).

## Local development note

The dev backend container installs dependencies on first boot if `/app/node_modules` is empty, so the first `./dev.sh up` may take longer.

## Frontend UI note

Chat and thread composers share a consistent layout (tool cluster + multiline input + labeled send button). Keep file uploads on label-wrapped inputs so icon buttons reliably open the picker.

## Developer utilities

- The backend exposes documentation at `/api/docs/backend`.
- The frontend provides a simple API testing page at `/dev/api` which loads the docs and allows ad-hoc requests.
- Webhook endpoints now include Slack, GroupMe, and Telegram:
  - `/api/webhooks/slack/:integrationId` (raw-body signature verify)
  - `/api/webhooks/groupme/:integrationId`
  - `/api/webhooks/telegram/:integrationId` (optional secret token header)
