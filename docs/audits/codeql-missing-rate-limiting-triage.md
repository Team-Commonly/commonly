# CodeQL `js/missing-rate-limiting` — backlog triage (TASK-097)

**Row:** TASK-097 · **Author:** kai · **Measured:** 2026-09-23 against `origin/main` @ `58232e6a`
**Status:** triage complete; enforcement **ruled** (wren 71373) — the public/anon per-route
half is a builder's row under this task, the mount-level half is **Sam's** call gated on a
measurement (§6).

The row asks two things: reconcile the disagreeing counts, then say which routes need a
limiter and which get a documented exemption. This is the measurement; §6 records the ruling
that came out of it.

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
6. **The call (§6), now ruled** (wren 71373): per-route on the public/anon surface is a
   **builder's row under this task**; the mount-level limiter on `/api/agents/runtime` is
   **Sam's own order**, not before the fleet's per-token steady state is measured against the
   existing 120/60s and a runtime 429 reads as a *named* refusal in one seat's tool path.
7. **The public/anon surface is small and measured: 8 production sites, all `GET`** (§6) — two
   of them the auth reads `/registration-policy` and `/verify-email`; five liveness/meta probes;
   one third-party redirect target.

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

**The "78" is reconciled, and it was a page artifact (vera, 71371).** Her query was the
alerts call **without `--paginate`**: it read the first 100 open alerts *of all rules*, 78 of
which happened to be this one. The same call with `--paginate` returns 349. So 349 is the
population and 78 was a page of it; the row's companion figure "38 in one file" comes from the
same page and is likewise unmeasured. See §7.

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

## 5. Exemptions, and the classes that get the IP tier only

Ruled (wren 71374): **third-party callbacks and long-poll reads are not exemptions** — they
carry the **IP tier with the token tier off**, because a retry storm from a third party is
still an IP, and a long-poll's request count is not a per-token budget question.

| class | flagged sites | members | treatment |
|---|---|---|---|
| test-file express apps | 3 | `__tests__/service/two-way-integration-e2e.test.js`, `__tests__/service/summaries.test.js`, `__tests__/unit/middleware/appAuth.test.js` | **exemption** — not production surface; the app is built inside the test |
| health / status / read-only meta | 6 | `health.ts` ×2, `pg-status.ts` ×2, `docs.ts`, `stats.ts` | **exemption candidate** — a limiter on a liveness probe can *be* the outage |
| third-party-triggered callbacks | 3 | `admin/globalIntegrations.ts` `GET /x/oauth/callback`, `discord.ts` `GET /callback`, `billing.ts` `POST /webhook` | **IP tier, token tier off** (ruled) |
| long-poll reads | 2 | `agentsRuntime.ts` `GET /events`, `GET /bot/events` | **IP tier, token tier off** (ruled) |

The remaining **186 of 200** sites are writes or authenticated reads: limiter candidates, not
exemption candidates.

## 6. The ruling (wren 71373): (D), split in two

The four options were (A) mount-level on the agent-runtime family, (B) per-route on the
public/anon surface, (C) leave the baseline as the record, (D) B now then A. **Ruled: (D),
split** — and the split is what makes it landable, because the two halves have different blast
radii:

- **(B) is now a builder's row under this task.** Per-route limiters on the public/anon
  surface, with a budget per route, and **each 429 body carries `status` and a named reason**
  so #1823's reader classifies it. Note the existing limiter bodies in `agentsRuntime.ts` are
  `{message, code: 'rate_limited'}` — no `status`, no named reason — so the *existing* shape is
  not enough for a seat's tool path; the new bodies need the fields the reader keys on, and the
  name must distinguish a **platform** 429 from an **upstream** one, which is a different fact.
- **(A) is Sam's own order, and not yet.** Two preconditions, both named by wren: the fleet's
  per-token steady state measured against the existing 120/60s, and a runtime 429 reading as a
  *named refusal* in one seat's tool path — the same legibility requirement the refusal work
  (TASK-099/#1828) exists to satisfy.

The existing budget the decision starts from, already two-tier in `agentsRuntime.ts`:
**IP tier 3000 / 60s** (Cloudflare-aware key, IPv6 collapsed to /64) then **token tier
120 / 60s** (`agentRateLimitKeyGenerator`). `phase4RateLimit` is the stack; registering only
`phase4IpRateLimit` is exactly "IP tier on, token tier off".

**Precondition (0), TASK-110** (vera 71399, verbatim): *Both tiers' budgets assume an IP key
the caller cannot choose.* `cloudflareIpRateLimitKeyGenerator` accepts `cf-connecting-ip` from
any peer, so a rotating header yields a fresh IP bucket per request; absent the header, all
external traffic arrives from the tunnel and shares one. **Numbers here are provisional until
the key is derived from a trusted-proxy check.** Until then every "per IP" figure below should
be read as "per key the caller may be able to choose".

### Scope of (B), measured

Public/anon here means: no auth/token/member/scope middleware anywhere in the registration
chain, strings stripped so a path like `/invite/:token` cannot masquerade as a guard.
**9 of the 200 flagged sites qualify, and one of them is the test-file app — so 8 production
sites, all `GET`:**

| route | file | why it is public | proposed IP budget |
|---|---|---|---|
| `GET /x/oauth/callback` | `admin/globalIntegrations.ts` | third-party redirect target | 600 / 60s |
| `GET /registration-policy` | `auth.ts` | read on the signup page, pre-auth by construction | 60 / 60s |
| `GET /verify-email` | `auth.ts` | link-driven: mail clients prefetch, scanners hammer it | 30 / 60s |
| `GET /public` | `stats.ts` | public read — limit it only if it does real work per request | exemption candidate (§5) |
| `GET /` | `health.ts` | liveness probe | exemption candidate (§5) |
| `GET /ready` | `health.ts` | readiness probe | exemption candidate (§5) |
| `GET /` | `pg-status.ts` | read-only meta | exemption candidate (§5) |
| `GET /backend` | `docs.ts` | read-only meta | exemption candidate (§5) |

**The three budgets are threat-model numbers, not measured ones** (vera 71390): the ingress
access log holds 5,417 requests over 24h and **zero** hits on `/verify-email` and
`/registration-policy` — mail clients and scanners have not been arriving in the window
sampled. There is no baseline to confirm or contradict them, so they are threat models ("a
human clicks once, a scanner hammers it") and are labelled as such rather than fitted to
traffic. They stay.

So (B)'s actionable surface is **3 routes** — the OAuth redirect target and the two auth reads —
plus the two IP-tier-only classes above; the other **190** flagged sites are authenticated and
belong to (A) or to the burn-down list. If `GET /public` turns out to do work per request it is
a fourth.

### Two constraints carried into (A) (wren 71383/71384)

- **The limiter store is in-memory and the backend runs `replicaCount: 1` today.** The existing
  budget is coherent only because there is one replica: at more than one, the same 120/60s
  bucket silently multiplies per replica unless the store is shared. Raising replicas without
  moving the store turns 120/60s into N x 120/60s, and nothing in the config says so.
- **The derived floor is 12 requests/min per seat** — the daemon polls every `intervalMs`
  (default 5000, `cli/src/commands/agent.js:850`), and that is *before* claims, lease renewals,
  heartbeats and tool calls. This is a **bound derived from source, not a measurement**, which
  is exactly why (A) waits on an instrument instead: a sampled log of `req.rateLimit.used` per
  key behind an env flag — the key is already `tok:<sha256>`, so no secret is logged. Filed as
  its own builder's row under this task (TASK-109).
- **Nothing persists a per-token request rate today** (vera 71378). `phase4AgentRateLimit` uses
  the default in-memory store, so the only place the real count exists is the live
  `RateLimit-Remaining` header, per backend process — and `tool_calls` cannot stand in: 5 rows
  all-time, one seat, 2026-09-18. So a "measured steady state" is either an instrument or it is
  a derivation, and the difference is stated rather than implied.
- **The instrument's shape is vera's to scope, Kai's to build** (wren 71398; vera 71401). Her
  scope, quoted: a **watermark log, not an access log** — one middleware registered immediately
  after `phase4RateLimit`, reading `req.rateLimit` (express-rate-limit 8.3.2 sets
  `{limit, used, remaining, resetTime}`), emitting a line only when
  `used >= RATE_LIMIT_OBSERVE_WATERMARK` (default 60, half of 120). An idle fleet emits
  nothing; the log records the approach to the ceiling, not the traffic.

**One risk worth putting in front of the (A) budget:** the fleet's seats run on **one host**
(the launchd supervisor), so they share a single egress IP — an **IP-tier-only** bucket is a
*shared* bucket for the whole fleet, not a per-seat one. 3000 / 60s is 50/s against roughly 30
seats reconnecting a long-poll on the order of once per 30s (~1/s), so the headroom is large,
but the number that matters for (A) is the per-token rate, and the number that matters for the
IP-tier-only rows is the *fleet-aggregate* rate. Both are measurements, not estimates, before
anything is mounted.

## 7. The 78, reconciled — a page read as a population

**vera 71371: 78 was hers and it was wrong.** Her query was the alerts call **without
`--paginate`** — the first 100 open alerts *of all rules*, 78 of which happened to be this one;
the same call with `--paginate` returns 349. The companion figure "38 in one file" comes from
that same page and is unmeasured. **349 is the population; 78 was a page of it.**

This is the third time in one night that this pod has hit the same shape — an unpaginated read
that looks exactly like a complete one — and it is worth naming, because it is invisible in
review: the query is well-formed, the output is plausible, and the only tell is a number that
does not match a second instrument. What made 200 trustworthy where 78 was not is not the count
itself: it is that the registration-chain walk resolves every site to a named registration and
that its first pass was wrong in both directions and is disclosed in §3 rather than reported as
the measurement.

Both figures were re-run on 2026-09-23 — the unpaginated call and the paginated one — which is
how the artifact was identified, and the reconciliation is vera's own (71371, restated 71385). **Nothing about the list narrows** — 349 records, 200 sites,
33 files stand, and so does the burn-down baseline of 232 registrations.

It does not disturb the conclusion the 78 was cited for: 21 alerts on #1814 against a
*population* larger than the cited one still says pre-existing rule, not new exposure — the
precondition short-circuit was the load-bearing half (vera 71372).

## Appendix — flagged sites per file

`agentsRuntime.ts` 26 · `pods.ts` 19 · `posts.ts` 12 · `skills.ts` 12 · `integrations.ts` 12 ·
`contextApi.ts` 12 · `apps.ts` 11 · `admin/users.ts` 9 · `admin/globalIntegrations.ts` 9 ·
`federation.ts` 9 · `agentEnsemble.ts` 8 · `providers/moltbot.ts` 7 · `registry/runtime.ts` 6 ·
`discord.ts` 6 · `analytics.ts` 6 · `users.ts` 5 · `github.ts` 5 · `registry/templates.ts` 4 ·
`auth.ts` 3 · `messages.ts` 2 · `admin/agentAutonomy.ts` 2 · `pg-status.ts` 2 · `dev.ts` 2 ·
`health.ts` 2 · `uploads.ts` 1 · `admin/agentEvents.ts` 1 · `tasksApi.ts` 1 · `test-bot.ts` 1 ·
`stats.ts` 1 · `docs.ts` 1 · `__tests__/service/two-way-integration-e2e.test.js` 1 ·
`__tests__/service/summaries.test.js` 1 · `__tests__/unit/middleware/appAuth.test.js` 1
