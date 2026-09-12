# API token show-once design note (B1 follow-up)

**Status:** proposed for implementation 2026-09-12  
**Owner:** Connectors lane (Kai); Vera exact-head gate

## Decision

`GET /api/auth/api-token` is a status endpoint, not a secret retrieval
endpoint. It returns `hasToken`, `createdAt`, `scopes`, and an optional `last4`
preview, but never the raw bearer. `POST /api/auth/api-token/generate` remains
the only response that carries a raw token. Calling it again is an explicit
rotation: the prior token is replaced and the newly issued token is shown once.
`DELETE /api/auth/api-token` continues to revoke the current token.

## Client migration

The V2 Settings page and the legacy `UserProfile` settings surface both call
the status endpoint on load. They use `hasToken`, `createdAt`, and `last4` for
the masked state; neither attempts to redisplay a token returned by `GET`.
After generate/rotate, the raw `apiToken` remains in local component state so
the user can copy it during that session. A reload intentionally loses the raw
value and shows metadata only. Revoke clears that local value and metadata.

## Compatibility and proof

The response keeps `hasToken` and `createdAt` unchanged, adds `scopes` and
`last4`, and removes the legacy `token` property. Existing callers that only
need to know whether a token exists remain compatible; callers that depended
on redisplaying the secret must use the generation response instead. Route
tests assert that an issued sentinel is absent from `GET`, the B1 matrix row is
removed, and the two Settings consumers render metadata after reload while
still revealing a newly generated token once.
