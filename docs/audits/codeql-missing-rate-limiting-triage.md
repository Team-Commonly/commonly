# CodeQL `js/missing-rate-limiting` — backlog triage (TASK-097)

**Row:** TASK-097 · **Author:** kai · **Measured:** 2026-09-23 against `origin/main` @ `58232e6a`
**Status:** triage complete; the enforcement choice is an open **Wren + Sam** call (§6).

The row asks two things: reconcile the disagreeing counts, then say which routes need a
limiter and which get a documented exemption. This is the measurement; the last section is
the question the code does not force.

## TL;DR

1. **349 open alerts = 200 distinct sites in 33 files** (`js/missing-rate-limiting` only).
   The `ref=refs/heads/main` filter is a **no-op**: filtered and repo-wide both return 349,
   because every one of these alerts' most-recent instance is already on `main`.
2. **322 of the 349 were created in 2026-04** (3 in September). The backlog is five months
   old and not growing; it re-attributes to whatever PR touches a shared dataflow node.
3. **They are true positives at the route level, not false positives through indirection.**
   Measured: **0 of the 200 flagged sites carry a limiter anywhere in their registration
   chain** (all 200 resolve to an enclosing `<router>.verb(` registration), while the
   agent-runtime routes that *do* carry `phase4RateLimit` are **not flagged at all**. The query
   recognises our inline limiter shape, so the flagged set is exactly the set the repo's own
   guard already records as unlimited. See §3 — this is the one finding that changes how the
   backlog should be read.
4. **3 sites are test-file express apps** (`__tests__/…`), not production surface.
5. The repo already owns a burn-down list for this exact surface:
   `backend/__tests__/unit/routes/routeRateLimitGuard.baseline.json` — **232 registrations**,
   which may only shrink, guarded in `npm test`.
6. **The decision (§6):** extend the existing two-tier limiter stack to the whole
   `/api/agents/runtime` family (behaviour change for every seat), do it per-route, or leave
   the baseline as the record. Recommended: **per-route on the public/anon-facing surface
   first, then the agent-runtime family with the existing 120/60s per-token budget** — but
   that second half is a Wren + Sam call by construction.

## How these numbers were produced

```bash
# alert rows, filtered to main (and the same query without the ref filter — identical counts)
gh api "repos/Team-Commonly/commonly/code-scanning/alerts?state=open&ref=refs%2Fheads%2Fmain&per_page=100" \
  --paginate -q '.[] | .rule.id' | sort | uniq -c | sort -rn

# the route-level view the repo already keeps, from the guard's own scanner
cd backend && node -e "const {scanRoutes}=require('./__tests__/utils/routeRateLimitScan.js');
  const r=scanRoutes(process.cwd()); console.log(r.length, r.filter(x=>x.reason!=='ok').length)"
```

## 1. Count reconciliation

| instrument | count | what it counts |
|---|---|---|
| code-scanning API, `state=open`, `ref=refs/heads/main` | **349** | alert rows, `js/missing-rate-limiting` only |
| code-scanning API, `state=open`, no ref filter | **349** | identical — the ref filter is a no-op (346 rows over route files + 3 over test files) |
| same set, distinct `(path, start_line)` | **200** | distinct source sites |
| same set, distinct `path` | **33** | files (30 route files, 3 test files) |
| distinct `(path, start_line, end_line)` | **302** | the same line appears with different end ranges |
| last JS analysis (`analyses?ref=…`) | 470 results | **all rules in that run**, not this rule |

The row's premise — that per-PR counts re-attribute — is confirmed by construction: an alert's
`most_recent_instance` moves to whichever analysis last saw the dataflow, and **21 alerts
re-attributed to #1814** while being main records (`#676` has been open since 2026-04-07).

`349 rows → 200 sites` is not double-counting: the query reports one alert per dataflow
instance, so the same registration can carry two alerts with different end ranges.

**Not yet reconciled: "78".** The row records "Vera counted 78 repo-wide"; no query shape I
tried produces it (349 filtered, 349 unfiltered, 200 distinct sites, 33 files, 332 files
above 78…). §7 poses the question rather than guessing — the answer decides whether the
backlog is 200 sites or something narrower.

## 2. The second instrument the repo already has

`routeRateLimitGuard.test.js` (readiness plan §3B row B3, landed 2026-09-12) scans every
`<router>.<verb>(path, …)` registration by name and compares against a baseline that **may
only shrink**:

| | count |
|---|---|
| registrations scanned | 436 |
| carry a limiter ahead of auth (`ok`) | **204** |
| baselined `unlimited` (burn-down list) | **232** |
| **fresh violations** | **0** |

So the repo's own view of this defect is 232 registrations, of which CodeQL flags 197 sites.
The guard is a *named* instrument and the query is a *dataflow* instrument; they agree on the
shape and differ on the population, and neither is the whole picture. The guard's baseline is
the burn-down list — this document does not duplicate it.

## 3. True positives, not indirection — and why that matters

The natural hope for a 5-month-old 349-alert backlog is "our limiter is applied through a
shape CodeQL cannot model". **Measured, that is false, and the counter-example is in the same
file as the largest cluster:**

- `backend/routes/agentsRuntime.ts` registers `phase4RateLimit` (an inline
  `express-rate-limit` stack, deliberately written inline "so CodeQL recognises the middleware
  against each route") on **7 routes** — `/messages/:messageId/claim` (POST/DELETE), `/room`,
  `/agent-dm`, `/pods/:podId/files` (GET), `…/files/:fileName/content`, `/pods/:podId/typing`.
  **None of those 7 appear in the alert set.**
- The other **26 sites in that file** carry no limiter — measured by walking from each flagged
  line back to its enclosing registration and testing the whole chain, `runtimeRouter` and
  `templatesRouter` included, not just `router` — and all 26 **are** in the alert set.

The file's own history agrees, and records the mechanism: a limiter placed *after*
`agentRuntimeAuth` leaves the Mongo lookup unprotected and the route flagged — cross-tabulated
on 2026-08-04 as ~37 routes with the limiter before auth (none flagged) vs 9 after (6 flagged).
Those routes were fixed on 2026-09-12 by moving the limiter first.

**Instrument note:** a first pass tested only the flagged line itself, which reported two
`auth.ts` sites as limited and missed every registration under a non-`router` variable name
(`runtimeRouter`, `templatesRouter`). The registration-chain walk is the measurement above;
the line-only version was wrong in both directions, and its two hits were the *next* route's
limiter, one line below the flagged one.

**Consequence for the backlog:** the 200 sites are genuinely unguarded registrations, and the
349 number is an instance count, not a defect count. Dismissing them per-PR would hide a real
burn-down list; treating 349 as 349 separate work items would overstate it. **It is one list of
232 registrations, 197 of which CodeQL also sees.**

## 4. Classification

By method (232 baselined registrations): `POST` 88 · `GET` 114 · `DELETE` 22 · `PATCH` 8.

The largest single cluster (26 sites) is `agentsRuntime.ts`; after it `pods.ts` 19,
`posts.ts`/`skills.ts`/`integrations.ts`/`contextApi.ts` 12 each.

**Agent-runtime family (the row's focus), 18 flagged sites in `agentsRuntime.ts`** plus
`agentEnsemble.ts` (8), `registry/runtime.ts` (6), `registry/files.ts`/`plugins.ts`,
`contextApi.ts` (12), `skills.ts` (12):

- seat loop traffic: `GET /events`, `GET /bot/events`, `POST /events/:id/ack`,
  `POST /bot/events/:id/ack`, `GET /memory`, `GET /installations`, `GET /pods/:podId/context`,
  `GET /pods/:podId/messages`
- seat posts: `POST /posts`, `POST /pods/:podId/messages`, `POST /threads/:threadId/comments`,
  `POST /pods/:podId/summaries`, `POST /pods/:podId/uploads`, `POST /dm`,
  `POST /pods/:podId/integrations/:integrationId/publish`
- admin/registry mutations: `runtime-start|stop|restart|clear-sessions`, `reprovision-all`,
  `trigger-heartbeat`, `session-token`, `installations` DELETE, `PATCH /pods/:podId/agents/:name`

## 5. Exemption candidates (documented, narrow)

| class | flagged sites | members | why an exemption is defensible |
|---|---|---|---|
| test-file express apps | 3 | `__tests__/service/two-way-integration-e2e.test.js`, `__tests__/service/summaries.test.js`, `__tests__/unit/middleware/appAuth.test.js` | not production surface — the app is built inside the test |
| health / status / read-only meta | 6 | `health.ts` ×2, `pg-status.ts` ×2, `docs.ts`, `stats.ts` | unauthenticated liveness and read-only probes; a limiter here can break the probe |
| third-party-triggered callbacks | 3 | `admin/globalIntegrations.ts` `GET /x/oauth/callback`, `discord.ts` `GET /callback`, `billing.ts` `POST /webhook` | retry behaviour is outside our control; the webhook family already carries the two-tier stack where we own the caller |
| long-poll reads | 2 | `agentsRuntime.ts` `GET /events`, `GET /bot/events` | counted per request, a poll loop's real cost is concurrency; a request-count limiter needs a budget that clears the fleet's steady state or seats 429 each other |

Everything else is a write or an expensive read and is a candidate for a limiter, not for an
exemption.

## 6. The call that is Wren's + Sam's

A limiter on `agentRuntimeAuth` itself changes behaviour for every seat, so this is not mine to
take. The existing budget in `agentsRuntime.ts` is the natural candidate because it already
exists and is already two-tier:

- **IP tier** 3000 / 60s, keyed by the Cloudflare-aware generator (IPv6 collapsed to /64)
- **token tier** 120 / 60s, keyed by `agentRateLimitKeyGenerator`

Options:

- **(A) Mount-level** — apply the same two-tier stack to `/api/agents/runtime` as a whole.
  Closes 18+ sites at one config point, uses budgets already proven against the fleet.
  Cost: every seat's poll loop now shares a 120/60s bucket; a runaway seat surfaces as a 429
  it cannot see in the tool path, which is the same class of failure as the 2026-08-18
  misclassification (an hour lost to an unreadable refusal).
- **(B) Per-route** — limit the write/expensive routes only, leave the reads.
  Smallest blast radius, N config sites, and it makes the guard's baseline shrink in
  measurable steps. Leaves the read surface unlimited.
- **(C) Leave the baseline as the record** — fix only the 3 test-file sites and accept 200
  forever. Cheapest; keeps re-attributing to every PR that touches a shared dataflow node.
- **(D) A+B** — B now on the public/anon-facing surface (highest exposure, lowest semantics
  risk), then A for the agent-runtime family once the fleet's real per-token request rate is
  measured against the 120/60s budget.

**Recommended: (D)**, with the fleet rate measured before A — the budget must be set from the
seats' actual steady-state (heartbeat + claim + long-poll) per token per minute, not guessed.
If A is taken, a 429 must be legible to the seat (the refusal work in TASK-099/#1828 is the
same shape) or the change will look like a broken seat rather than a limiter.

## 7. The one question I could not answer

**@vera: what produced "78 repo-wide"?** My shapes are above (349 filtered, 349 unfiltered,
200 distinct sites, 33 files, 302 distinct path+line+end). Any of these could be your 78 by a
different filter — a ref other than `main`, severity, a single analysis run, or the UI's
grouping. The answer decides whether the burn-down list is 232 registrations or something
narrower, so it is worth pinning rather than averaging.

## Appendix — flagged sites per file

`agentsRuntime.ts` 26 · `pods.ts` 19 · `posts.ts` 12 · `skills.ts` 12 · `integrations.ts` 12 ·
`contextApi.ts` 12 · `apps.ts` 11 · `admin/users.ts` 9 · `admin/globalIntegrations.ts` 9 ·
`federation.ts` 9 · `agentEnsemble.ts` 8 · `providers/moltbot.ts` 7 · `registry/runtime.ts` 6 ·
`discord.ts` 6 · `analytics.ts` 6 · `users.ts` 5 · `github.ts` 5 · `registry/templates.ts` 4 ·
`auth.ts` 3 · `messages.ts` 2 · `admin/agentAutonomy.ts` 2 · `pg-status.ts` 2 · `dev.ts` 2 ·
`health.ts` 2 · `uploads.ts` 1 · `admin/agentEvents.ts` 1 · `tasksApi.ts` 1 · `test-bot.ts` 1 ·
`stats.ts` 1 · `docs.ts` 1 · `__tests__/service/two-way-integration-e2e.test.js` 1 ·
`__tests__/service/summaries.test.js` 1 · `__tests__/unit/middleware/appAuth.test.js` 1
