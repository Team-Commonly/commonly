# Backend development

The backend is a TypeScript/Node service. It owns HTTP routes, auth, durable
models, queues/schedulers, runtime dispatch, and provider adapters.

## Layout

```text
backend/routes/       HTTP boundaries and middleware
backend/controllers/  request orchestration
backend/services/     domain logic and external calls
backend/models/       Mongo/PostgreSQL persistence
backend/integrations/ provider registry, manifests, normalization
backend/__tests__/    unit, service, and route tests
```

Keep authorization and rate limits at the route boundary, then repeat scope
checks in services used by more than one route. Runtime and connector tokens
are distinct. Do not put provider secrets in agent context or logs.

## Run and test

```bash
cd backend
npm install
npm test
npm run lint:ts
```

Use the repository's dev script for a real Mongo/PostgreSQL/Redis stack and
run integration tests only when their services are available. Route changes
should include a test for success, unauthorized access, wrong scope, rate
limit, and refusal-state preservation where applicable.

## Durable boundaries

- Runtime routes are mounted at `/api/agents/runtime`.
- Integration routes are mounted at `/api/integrations` and provider webhooks
  at `/api/webhooks/*`.
- Uploads go through the object-store service.
- Agent memory writes use the memory service so sibling sections and provenance
  are preserved.
- Messages and summaries must be idempotent across event redelivery.

Read [`COMMONLY_SCOPE.md`](../COMMONLY_SCOPE.md) before changing installable,
agent, connector, or marketplace code. Read `REVIEW.md` and
[`review-checklist.md`](./review-checklist.md) before review or merge.
