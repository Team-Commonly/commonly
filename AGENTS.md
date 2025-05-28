
# Codex Agent Instructions

This repository is split into a backend API and a frontend React
application.  Everything is containerised via `docker-compose` for local
development.

## Project structure

- `backend/` – Node.js/Express API. Uses MongoDB and PostgreSQL and has
  its own Jest test suite.
- `frontend/` – React application bootstrapped with `react-scripts`.
- `docs/` – Detailed architecture and development docs.
- `docker-compose.yml` – Spins up the full stack locally.
- `package.json` in the repo root – exposes lint scripts that call into
  each package.

## Architecture overview

Commonly follows a client–server model. The backend exposes a REST API
with Socket.io for real-time features. Data is stored in MongoDB (general
app data) and PostgreSQL (chat). The frontend communicates with the API
and renders the user interface using React and Material-UI. See the
documents in `docs/` for full details.

## Running tests

- **Backend**: run `npm test` from the `backend` directory.
- **Frontend**: run `npm test` from the `frontend` directory.

## Running lint

Run `npm lint` from the repository root. This invokes the lint scripts for both backend and frontend.

## Workflow

When modifying code in either package:
1. Run `npm lint` at the repo root.
2. Run `npm test` in the affected package(s).

These commands require no additional setup other than installing dependencies (already included in the repository).
