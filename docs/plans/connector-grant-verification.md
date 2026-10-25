# Connector grant verification (TASK-289)

Status: draft. The scenario extends TASK-514's production app factory at
`d8a9494d7` on `test/task-514-http-scenarios`. It is not ordinary-user onboarding
clearance and has no public activation or merge clearance.

## Current scenario

`backend/__tests__/service/verify.connectorGrant.test.js` uses the production
HTTP mount table and authentication, MongoDB and a real PostgreSQL server. No
route, middleware, provider service or database model is mocked. GitHub requests
are intercepted at Axios's HTTP adapter. The fixture generates its own RSA App
key and installation token; no real vendor account or credential is used.

The checks cover:

- A fresh ordinary member cannot connect the server-held GitHub App credential.
- An administrator connects one repository and issues a read-only grant to one
  current agent in a private, invite-only pod on the narrowed native runtime.
- The authenticated agent reads issues through the real MCP HTTP endpoint.
- An ungranted write and caller-supplied repository are refused before vendor
  I/O. The provider sees only the configured installation and repository.
- PostgreSQL persists all three outcomes with grant, caller, pod, credential
  owner where resolved, and argument digests. The HTTP audit read exposes them.
- Responses and audit rows exclude token values, the App key and raw arguments.

## Unresolved acceptance boundary

At main `4eed277a8`, `POST /api/integrations/github-app` is explicitly admin-only;
the generic connection route also rejects `github-app`. This protects the
server-held App credential. The scenario therefore names its happy path
**admin bootstrap**. It does not promote the ordinary member to admin or seed
an ordinary user's connection directly to make the requested path appear green.

TASK-289's request for a new user to connect GitHub still needs either a
user-owned connection flow or an explicit narrowing of this acceptance scope.
That ruling remains pending. The security boundary remains unchanged.

## Harness integration and running

This is a local/CI mutating fixture. The shared setup drops its Mongo database
and initializes/truncates its PostgreSQL test tables. Supply fresh, isolated
test databases. Never point it at a shared, staging or production database.

With the backend test dependencies installed and real test databases configured:

```sh
INTEGRATION_TEST=true npm --prefix backend test -- --runInBand \
  --runTestsByPath __tests__/service/verify.connectorGrant.test.js
```

The `commonly verify` CLI registry is not present at the referenced TASK-514
head. Its owner must wire the `connector-grant` name to this scenario; this
change does not introduce a second runner. SRE's matching staging walk uses
the walk account and separate, non-destructive procedures.

A 512 MiB Node heap cap and isolated transpilation were used for the initial
local behavioral run. Both cases passed with real PG and the process exited with code 0. Jest warned
about a delayed exit before it settled. This is not a final
verification verdict or evidence of ordinary-user onboarding.
