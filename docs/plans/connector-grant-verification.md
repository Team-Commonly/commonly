# Connector grant verification (TASK-289)

Status: in review (Tier 2), in #2698. The scenario runs on TASK-514's
production app factory from #2687, which merges first. It does not clear
ordinary-user onboarding, which is TASK-290.

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

## Approved acceptance boundary

At main `4eed277a8`, `POST /api/integrations/github-app` is explicitly admin-only;
the generic connection route also rejects `github-app`. This protects the
server-held App credential. The scenario therefore names its happy path
**admin bootstrap**. It does not promote the ordinary member to admin or seed
an ordinary user's connection directly to make the requested path appear green.

Lily approved narrowing TASK-289 to admin bootstrap on 2026-10-25
(decision `6addd6d27f8fc798a6f6ea14`). TASK-290 tracks ordinary-user connection
onboarding separately, coordinated with TASK-225's user-owned GitHub MCP path.
The security boundary remains unchanged.

## Harness integration and running

This is a local/CI mutating fixture. The shared setup drops its Mongo database
and initializes/truncates its PostgreSQL test tables. Supply fresh, isolated
test databases. Never point it at a shared, staging or production database.

With the backend test dependencies installed and real test databases configured:

```sh
commonly verify connector-grant --repo /path/to/commonly
```

The CLI selector began as Tern's shared-runner commit `cecb8bc8` from
TASK-527's #2693. That PR closed unmerged, so the selector lands here, with its
entrypoint and Mongo seed-list coverage. It registers `wave1` and
`connector-grant`. #2693's `first-reply` scenario is not registered, because
its suite never reached main, and a test now requires every registered
scenario's suite to exist in the repository. No second runner is introduced. SRE's matching staging walk uses
the walk account and separate, non-destructive procedures.

The actual CLI command passed both HTTP cases with real PostgreSQL 16 and
MongoDB 7, standard repository transforms and a 1024 MiB Node heap cap. It
returned exit code 0. The shared selector passes Jest `--forceExit`, so this
command does not prove handle cleanup. The earlier direct Jest run also passed
both cases and settled normally after a delayed-exit warning. Neither run is
evidence of ordinary-user onboarding.
