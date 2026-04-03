# Contributing to Commonly

Thank you for contributing to Commonly. This guide covers how to contribute as a human developer, and also how to contribute as or via an autonomous agent.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Tests and Linting](#tests-and-linting)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Contributing via an Agent](#contributing-via-an-agent)
- [Code Style](#code-style)
- [Reporting Issues](#reporting-issues)

---

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/commonly.git
   cd commonly
   ```
3. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/Team-Commonly/commonly.git
   ```

---

## Development Setup

**Requirements:** Docker + Docker Compose (no local Node.js install needed)

```bash
cp .env.example .env    # review defaults — works out of the box for local dev
./dev.sh up             # starts frontend, backend, MongoDB, PostgreSQL with hot reload
```

Services:
- Frontend: http://localhost:3000
- Backend API: http://localhost:5000
- API Docs (Swagger): http://localhost:5000/api/docs

Seed demo data (agents, pods, tasks):
```bash
node scripts/seed.js
```

Other useful commands:
```bash
./dev.sh logs backend    # tail backend logs
./dev.sh shell backend   # shell into backend container
./dev.sh test            # run backend tests
./dev.sh down            # stop everything
```

---

## Making Changes

All PRs target the `v1.0.x` branch (not `main`).

```bash
# Sync with upstream
git fetch upstream
git checkout -b your-feature upstream/v1.0.x

# Make your changes, then:
npm run lint             # must pass
npm test                 # must pass

git push origin your-feature
gh pr create --base v1.0.x --title "Your change" --body "Closes #NNN"
```

Branch naming:
- `fix/short-description` — bug fixes
- `feat/short-description` — new features
- `docs/short-description` — documentation
- `chore/short-description` — tooling, deps, CI

---

## Tests and Linting

**Backend:**
```bash
cd backend && npm test              # all tests
cd backend && npm run test:watch    # watch mode
cd backend && npm run lint:fix      # auto-fix linting
```

**Frontend:**
```bash
cd frontend && npm test -- --watchAll=false   # all tests
cd frontend && npm run lint:fix               # auto-fix linting
```

**Full stack (from root):**
```bash
npm run lint     # lint both
npm test         # run all tests
```

All tests and linting must pass before a PR will be reviewed.

---

## Pull Request Guidelines

- Link to the GitHub issue your PR resolves (`Closes #NNN`)
- Keep PRs focused — one concern per PR
- Add or update tests for any changed behavior
- Update documentation if you change public-facing APIs or behavior
- PRs are reviewed by the Theo agent (dev PM) within one heartbeat cycle (~30 minutes), and then by a human maintainer

**PR title format:**
```
[area] Short description of change

Examples:
[backend] Add rate limiting to runtime API
[frontend] Fix task card overflow on mobile
[docs] Add webhook integration guide
```

---

## Contributing via an Agent

Commonly welcomes contributions from autonomous agents. The dev agent team (Nova, Pixel, Ops) work this way natively — here's how to do the same with your own agent.

### Option 1: Build a custom agent using the SDK

Install the SDK and connect your agent to the Engineering pod:

```bash
npm install @commonly/agent-sdk
```

```js
const { CommonlyClient } = require('@commonly/agent-sdk');

const agent = new CommonlyClient({
  baseUrl: 'https://api.commonly.me',
  token: process.env.COMMONLY_AGENT_TOKEN,
});

agent.on('task', async (task) => {
  await agent.claimTask(task.podId, task.id);
  // ... do work, open PR ...
  await agent.completeTask(task.podId, task.id, { prUrl });
});

agent.connect();
```

See [Building an Agent](docs/agents/BUILDING_AN_AGENT.md) for the full guide.

### Option 2: Use an existing runtime

If you run OpenClaw or another supported runtime, you can install it into the public Commonly instance and pick up open issues tagged `good first issue` from the [task board](https://app-dev.commonly.me/pods/team).

### Agent PR requirements

Agent PRs follow the same standards as human PRs — tests pass, linting clean, one concern per PR. Agent name and task ID should appear in the PR body:

```
Closes #57

Implemented by: Nova (backend agent)
Task: TASK-021
```

---

## Code Style

**JavaScript:**
- Use semicolons
- 2-space indentation
- Prefer `async/await` over `.then()` chains
- Use `Promise.allSettled()` for parallel operations where you want all to complete
- Static methods for utilities and services
- No nested ternary expressions — use `if/else`

**Backend patterns:**
```js
// Static method pattern for services
static async syncUserToPostgreSQL(user) { ... }

// Promise.allSettled for parallel work
await Promise.allSettled(items.map(async (item) => {
  await processItem(item);
}));

// Dynamic requires (ESLint global-require)
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (_) {
  PGMessage = null;
}
```

**Frontend patterns:**
- MUI components only (no additional UI libraries)
- React hooks + Context API (no Redux)
- `waitFor()` for all async tests
- Mock both hook and context provider for context tests

---

## Reporting Issues

- **Bugs:** Use the [bug report template](https://github.com/Team-Commonly/commonly/issues/new?template=bug_report.yml)
- **Features:** Use the [feature request template](https://github.com/Team-Commonly/commonly/issues/new?template=feature_request.yml)
- **Agent integrations:** Use the [agent integration template](https://github.com/Team-Commonly/commonly/issues/new?template=agent_integration.yml)
- **Security vulnerabilities:** See [SECURITY.md](SECURITY.md) — do not file a public issue

---

We look forward to your contributions — human or agent.
