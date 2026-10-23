---

name: testing
description: Testing and code quality context for Jest, React Testing Library, ESLint, and test patterns. Use when writing tests or fixing linting issues.
last_updated: 2026-04-02
---

# Testing & Quality

**Technologies**: Jest, React Testing Library, Supertest, ESLint

## Required Knowledge
- Jest test framework
- React Testing Library patterns
- API testing with Supertest
- In-memory database testing (MongoDB Memory Server, pg-mem)
- ESLint configuration
- Test-driven development

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [LINTING.md](../../../docs/development/LINTING.md) | ESLint setup, auto-fix, IDE integration |
| [BACKEND.md](../../../docs/development/BACKEND.md) | Backend testing patterns |
| [FRONTEND.md](../../../docs/development/FRONTEND.md) | Frontend testing patterns |

## Testing Commands

```bash
# Unit tests (in-memory DBs — no services needed, default)
cd backend && npm test
cd backend && npm run test:coverage
./dev.sh test                        # same, runs inside Docker container

# Integration tests (real Docker Compose services)
./dev.sh up                          # start mongo + postgres first
./dev.sh test:integration            # INTEGRATION_TEST=true npm test --forceExit
# or manually:
INTEGRATION_TEST=true npm --prefix backend test -- --forceExit

# Frontend tests
cd frontend && npm test
cd frontend && npm run test:coverage

# Linting
npm run lint
npm run lint:fix
```

## INTEGRATION_TEST env var

`backend/__tests__/setup.js` switches between two modes:

- **`INTEGRATION_TEST` not set** (default): sets `PG_HOST=undefined` and `MONGO_URI=undefined` → triggers in-memory MongoDB Memory Server + pg-mem
- **`INTEGRATION_TEST=true`**: connects to real services:
  - MongoDB: `localhost:27017` (db: `commonly-test`)
  - PostgreSQL: `localhost:5432` (db: `commonly-test`, user: `postgres`, no SSL)
  - Requires `./dev.sh up` to be running first

Override connection strings via env vars: `MONGO_URI`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`.

## High-value Current Test Areas

### E2E Integration Tests
- **Two-Way Integration E2E**: `backend/__tests__/integration/two-way-integration-e2e.test.js` (23 tests)
  - Inbound flow: External platforms (GroupMe, Discord) → Commonly via ingest endpoint
  - Scheduler summarization: Buffer processing and agent event queuing
  - Agent posting: commonly-bot posting summaries to pods via runtime API
  - Outbound flow: Commonly → Discord webhooks / GroupMe bot API
  - Full round-trip: External → Commonly → External
  - Multi-agent: Clawdbot, custom agents, agent chaining
- **Integrations E2E**: `backend/__tests__/integration/integrations-e2e.test.js`
- **Clawdbot E2E**: `backend/__tests__/integration/clawdbot-e2e.test.js`

### Contract and Unit Tests
- Integration provider contract tests: `backend/__tests__/contracts/integrationProvider.contract.test.js`.
- Integration catalog + manifest validation routes.
- `backend/__tests__/unit/routes/integrations.catalog.test.js`.
- `backend/__tests__/unit/routes/integrations.validation.test.js`.
- Pod context and skill synthesis.
- `backend/__tests__/unit/routes/pods.context.test.js`.
- `backend/__tests__/unit/services/podContextService.test.js`.
- `backend/__tests__/unit/services/podSkillService.test.js`.

## Backend Testing Patterns

### Unit Test
```javascript
describe('MessageService', () => {
  it('should create a message', async () => {
    const message = await MessageService.create({
      podId: 'pod123',
      userId: 'user123',
      content: 'Hello'
    });
    expect(message.content).toBe('Hello');
  });
});
```

### API Test
```javascript
describe('POST /api/messages', () => {
  it('should create message', async () => {
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ podId: 'pod123', content: 'Hello' });
    expect(res.status).toBe(201);
  });
});
```

## Frontend Testing Patterns

### Component Test
```javascript
describe('ChatRoom', () => {
  it('renders messages', async () => {
    render(<ChatRoom podId="123" />);
    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });
  });
});
```

### Mock Axios
```javascript
jest.mock('axios');
axios.get.mockResolvedValue({ data: mockMessages });
```

## E2E Integration Testing Patterns

### Two-Way Integration Test Setup
```javascript
// Mock summarizer to avoid Gemini API calls
jest.mock('../../services/summarizerService', () => ({
  generateSummary: jest.fn().mockResolvedValue('AI-generated summary.'),
  summarizePosts: jest.fn().mockResolvedValue({ title: 'Posts Summary', content: 'Summary' }),
  summarizeChats: jest.fn().mockResolvedValue({ title: 'Chats Summary', content: 'Summary' }),
}));

// Mock external APIs
jest.mock('axios');
global.fetch = jest.fn();
```

### Ingest Token Creation Pattern
```javascript
const { hash, randomSecret } = require('../../utils/secret');

const createIngestToken = async (integrationId) => {
  const token = `cm_int_${randomSecret(16)}`;
  const tokenHash = hash(token);
  await Integration.findByIdAndUpdate(integrationId, {
    $push: {
      ingestTokens: {
        tokenHash,
        label: 'Test Token',
        createdBy: testUser._id,
        createdAt: new Date(),
      },
    },
  });
  return token;
};
```

### Agent Runtime Token Pattern
```javascript
// Install agent
await request(app)
  .post('/api/registry/install')
  .set('Authorization', `Bearer ${authToken}`)
  .send({
    agentName: 'commonly-bot',
    podId: testPod._id.toString(),
    scopes: ['context:read', 'summaries:read', 'messages:write'],
  });

// Get runtime token
const tokenRes = await request(app)
  .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
  .set('Authorization', `Bearer ${authToken}`)
  .send({ label: 'Test Token' });

const runtimeToken = tokenRes.body.token;

// Post message as agent
await request(app)
  .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
  .set('Authorization', `Bearer ${runtimeToken}`)
  .send({ content: 'Summary content', messageType: 'text' });
```

### Multi-Agent Test Pattern
```javascript
// Install multiple agents on same pod
await Promise.all([
  request(app).post('/api/registry/install').set('Authorization', `Bearer ${authToken}`)
    .send({ agentName: 'commonly-bot', podId: testPod._id.toString(), scopes: [...] }),
  request(app).post('/api/registry/install').set('Authorization', `Bearer ${authToken}`)
    .send({ agentName: 'clawdbot', podId: testPod._id.toString(), scopes: [...] }),
]);

// Enqueue events for each agent
await AgentEventService.enqueue({ agentName: 'commonly-bot', podId, type: 'discord.summary', payload: {...} });
await AgentEventService.enqueue({ agentName: 'clawdbot', podId, type: 'integration.summary', payload: {...} });

// Each agent polls their own events
const commonlyPoll = await request(app).get('/api/agents/runtime/events')
  .set('Authorization', `Bearer ${commonlyToken}`);
const clawdbotPoll = await request(app).get('/api/agents/runtime/events')
  .set('Authorization', `Bearer ${clawdbotToken}`);
```

## ESLint Configuration

```javascript
// .eslintrc.js
module.exports = {
  extends: ['eslint:recommended', 'plugin:react/recommended'],
  rules: {
    'no-unused-vars': 'error',
    'no-console': 'warn'
  }
};
```

## Current Repo Notes (2026-02-08)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
Social/activity route coverage now includes:
- `backend/__tests__/unit/routes/users.social.test.js` (user follow/unfollow routes)
- `backend/__tests__/unit/routes/activity.read.test.js` (unread count + mark-read routes)
- `backend/__tests__/unit/routes/posts.test.js` extended for thread follow routes.
