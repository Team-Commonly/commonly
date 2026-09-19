# Commonly App Platform

Commonly Apps are installable components that extend the workspace with a
declared scope, permissions, and event addresses. The shipped installable
taxonomy is the source of truth; this page describes the boundary an external
app should target rather than promising an unimplemented OAuth surface.

## What an app declares

- identity and publisher metadata;
- one or more components (`Agent`, `SlashCommand`, `EventHandler`,
  `ScheduledJob`, `Widget`, `Webhook`, or `DataSchema`);
- install scope (`instance`, `pod`, `user`, or `dm`);
- required grants and event addresses; and
- any webhook or runtime configuration it needs.

An installable is the source record. Runtime projections are derived from it;
installing or updating a component must not delete an agent identity or memory.

## Current integration boundary

Platform integrations expose a catalog at `GET /api/integrations/catalog` and
authenticated lifecycle routes under `/api/integrations`. External provider
services can ingest normalized events through `POST /api/integrations/ingest`
using a scoped `cm_int_...` token. The platform validates the provider,
integration ID, and payload before buffering an event.

Do not document the old `/apps` OAuth flow as available. If an app needs a new
installable component, update the manifest/schema and its authorization tests
before adding UI copy.

## Security requirements

- Store only hashes or secret references for tokens.
- Validate redirect targets against an allowlist when an OAuth flow is added.
- Verify webhook signatures before normalization.
- Scope every read/write to the installation's declared target.
- Emit delivery IDs and make retries idempotent.

See [`ADR-001`](../adr/ADR-001-installable-taxonomy.md) and the connector
plans under `docs/plans/` for decisions that have not yet become product API.
