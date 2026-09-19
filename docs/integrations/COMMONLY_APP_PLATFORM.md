# Commonly App Platform (Design + current API boundary)

Goal: let third parties register “Commonly Apps” (similar to GitHub Apps) that can receive events via webhooks and call Commonly APIs using scoped credentials. Works alongside the integration SDK so providers can be added with minimal friction.

The app platform has a shipped owner/installation API and marketplace read
path, but the OAuth-style consent screen and code-for-token exchange described
below are still design work. Treat this document as a boundary between the
current routes and the proposed external-developer flow.

## Core concepts
- **App**: metadata + credentials owned by a developer/team.
- **Installation**: links an App to a pod (or user) with granted scopes.
- **Webhook**: per-app callback URL + secret used for event delivery.
- **Subscriptions**: list of event types the app wants (messages, summaries, membership, posts, files, integrations, etc.).
- **OAuth-ish flow**: apps are installed via a consent screen; installs create tokens scoped to the pod/user.
- **Apps Marketplace**: UI surface at `/apps` for browsing and installing apps into pods.
- **Agent Hub**: separate UI at `/agents` for agent registry installs (pod-native agent profiles).
- **Official Marketplace Manifest**: curated listings from `/api/marketplace/official` (backed by `packages/commonly-marketplace/marketplace.json`).
  - Configure `MARKETPLACE_MANIFEST_URL` to point at the external marketplace repo (raw JSON).
  - `MARKETPLACE_MANIFEST_PATH` can be used for local dev fallback.
  - `MARKETPLACE_MANIFEST_TTL_MS` controls cache TTL.
  - `REACT_APP_MARKETPLACE_CONTRIB_URL` controls the “Submit App” CTA in `/apps`.
  - MCP Apps can be listed with `type="mcp-app"` and optional `mcp.resourceUri` metadata for MCP-compatible hosts.

## Data model (proposed)
- `App` (Mongo): name, description, homepage, callback URL, webhook URL, webhook secret, public key (optional), clientId, clientSecret, ownerId, allowedRedirects, defaultScopes, allowedEvents, status.
- `AppInstallation` (Mongo): appId, targetType (`pod|user`), targetId, scopes granted, events subscribed, createdBy, createdAt, token (hashed), tokenExpiresAt, status.
- Reuse `Integration` only for built-in providers; keep apps separate to allow arbitrary external services.

## Event delivery
- Commonly emits events -> enqueue -> sign payload with HMAC using webhook secret -> POST to app webhook.
- Delivery headers: `X-Commonly-Event`, `X-Commonly-Signature-256`, `X-Commonly-Delivery` (uuid), `User-Agent: Commonly-App-Hook/v1`.
- Retry policy: exponential backoff, max attempts, dead-letter.

## Auth for incoming API calls
- Install-level token (Bearer) with scopes. Scopes examples:
  - `pods:read`, `pods:write`
  - `messages:read`, `messages:write`
  - `summaries:read`
  - `files:read`
- Rotate token via `/api/apps/installations/:id/token` (requires app client secret).

## Registration & installation flow
1) **Developer creates app** via Commonly UI/API:
   - set name, description, callback URL(s), webhook URL, choose default scopes/events.
   - system issues `clientId`, `clientSecret`, and `webhookSecret`.
2) **Install**: user hits `/apps/install?client_id=...&redirect_uri=...&pod_id=...&scopes=...&state=...`.
3) **Consent screen** shows scopes + events; on accept, create `AppInstallation`, generate install token, redirect back with `installation_id` and `code`.
4) **Token exchange** (optional): app swaps `code` + `clientSecret` for install token.

## API surface

Implemented routes (all owner/install routes require user auth):
- `GET /api/apps` - list apps owned by the caller.
- `POST /api/apps` - create an app and return its client/webhook secrets once.
- `GET /api/apps/:id` - read an owned app.
- `POST /api/apps/:id/rotate-secret` - rotate the client secret.
- `POST /api/apps/:id/webhook-test` - generate a signed sample payload.
- `POST /api/apps/installations` - create an installation for a target.
- `DELETE /api/apps/installations/:id` - remove an installation.
- `GET /api/apps/pods/:podId/apps` - list apps installed in a pod.
- `POST /api/apps/pods/:podId/apps` - install an app in a pod.
- `DELETE /api/apps/pods/:podId/apps/:installationId` - uninstall a pod app.
- `GET /api/apps/marketplace` and `GET /api/apps/marketplace/:id` - read marketplace listings.

Not yet served: the proposed `/api/apps/install` consent URL, OAuth-style
code exchange, and `GET /api/apps/:id/installations`. Do not document those as
available integrations until their routes land.

## Event types (initial)
- `message.created`, `message.deleted`
- `summary.created`
- `pod.member.joined`, `pod.member.left`
- `file.uploaded`
- `integration.status.changed`

## Security
- Mandatory webhook signature verification (HMAC SHA-256 with `webhookSecret`).
- Validate `redirect_uri` against allowlist.
- Token hashing at rest.
- Per-install scope enforcement on every API route.

## SDK alignment
- The open-source integration SDK can expose helpers to verify Commonly webhook signatures and manage install tokens.
- Providers built for Commonly can live outside the main repo and just rely on this contract + webhooks.

## Deliverables to build
- Mongo schemas for App and AppInstallation.
- Routes + controllers for app CRUD, installation, token exchange, webhook test.
- Middleware for scope checks and webhook signature validation.
- UI: developer settings page + consent screen.
- Docs: quickstart, event list, signing guide, example payloads.
