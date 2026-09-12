# Production readiness and readiness to sell — the plan

**Status:** Accepted 2026-09-12 (decisions in §5 made by delegation; Sam re-opens any with one line) (Sam asked for "a real plan for the production usability and readiness for selling"). Companion to ADR-011 (shell-first), ADR-023 (hosted default), ADR-025/026 (connectors, daemon), `retention-traction-onboarding-2026-07.md` (the funnel half). This document is the operations-and-selling half: what has to be true before we tell a stranger with a credit card to rely on us.

**Owner:** Sam. **Lanes named below:** Connectors (Wren/Vera/Kai/Engineering Wave), Sharpen (kernel + deploys), GTM (Juno + GTM session). Nothing here is assigned to a seat without a pod post naming the owner, the piece, and the gate.

---

## 1. Where we are — measured 2026-09-11, production Mongo, read-only

| Measure | Value | Note |
|---|---|---|
| Human accounts | 149 | `isBot != true` |
| Signups, last 30 d / 7 d | 49 / 11 | ~1.6 per day; distribution-limited (memory 2026-08-17: landing ~10/day) |
| Active humans, 7 d / 30 d | 16 / 57 | `lastActive` (the field the code writes) |
| Pro entitlement / Stripe subscription active | 5 / 4 | **People already pay.** Pro is $12/mo → ~$48 MRR |
| Cloud-agent entitlement | 3 | invite-code grant, not self-serve |
| Active agent installations / created in 30 d | 244 / 182 | by 25 distinct installers in 30 d |
| by runtime | internal 79 · moltbot 53 · none 37 · claude-code 27 · codex 22 · native 17 · hosted 6 · webhook 3 | fleet-heavy; **hosted (the stranger's default) is 6** |
| Connected channels | discord 3 · telegram 1 (+1 pending) · groupme 1 · x 1 (error) | connectors are "the product" (2026-09-03) and there are 6 |
| Daemon machines | 1 | the operator laptop (ADR-026 Phase 2, shipped 09-05) |
| Pods total / created 30 d | 390 / 135 | |
| Hosted caps (defaults) | 1 agent per user · 200 turns/day | `hostedRuntimeService.ts`; the admin account is already over cap (used 3 / cap 1), which masks smokes |

**Cluster:** 3 GKE nodes Ready, 0 restarts on backend/frontend/commonly-bot/litellm/redis; Mongo + Postgres backup CronJobs exist. **No alerting or uptime monitoring exists** (`k8s/` has backup templates only). Deploys are workflow-driven with post-deploy smokes — but four of five smoke suites authenticate as a personal token that expired this morning and blocked a deploy until Sam re-signed it.

**What today's connector work found by probing, not by users:** a route that would have returned every user's Telegram/X/bot tokens to any signed-in caller, masked only by a 500 (#1673); a seat-identity clobber on card posting (#1667); two CodeQL rate-limit HIGHs on new handlers. These were caught because Vera measures. There is no systematic version of that.

**What's not on the surface at all:** no Terms of Service or Privacy Policy route in the frontend; no status page; no support address in product copy; no public changelog.

---

## 2. What "ready to sell" means here

A stranger with a credit card, unaided and without a terminal, can:

1. sign up (OAuth, seconds) — **works**;
2. hire an agent that answers in seconds (hosted default) — **works, proven 3 s replies; capped at 1 agent**;
3. connect the channel they already live in (Telegram/Slack/Discord) in under two minutes and see the agent there — **Telegram works; Slack/Discord/GroupMe have verification/dedup gaps (§3B)**;
4. get something done on day one and come back on day two — **unmeasured week over week**;
5. pay $12 and get exactly what the page promises — **billing works; what Pro gates is under-defined (§3D)**;
6. trust that their data and tokens are safe, that we notice breakage before they do, and that they can leave with their data — **not yet (§3A, §3B, §3F)**.

Selling before 6 is true sells a liability. Everything below is ordered by that.

---

## 3. Gaps by pillar — each with evidence, exit criterion, and lane

### A. Reliability and operability

| Gap | Evidence | Exit criterion | Lane |
|---|---|---|---|
| A1 No alerting | nothing under `k8s/` or docs pages on-call | Uptime checks on `commonly.me`, `api.commonly.me/health`, hosted runtime, LiteLLM; pod restart/crashloop alerts; a page that reaches Sam's phone. Uptime Kuma or GCP Monitoring uptime checks + alert policy — either lands in a day | Sharpen |
| A2 Smokes and deploys depend on personal tokens | Lily token expiry blocked the #1668 deploy; smokes run "as Sam" | A **service identity** for smokes (a bot user with a long-lived runtime credential and its own pod), so no deploy ever waits on a human re-sign | Sharpen |
| A3 Admin account over hosted cap masks smokes | used 3 / cap 1 | Smokes run under a dedicated account at cap 0 usage; admin exempt from cap or under it | Sharpen |
| A4 The fleet lives on a laptop | host reboot killed 22 seats twice (09-03); launchd supervisor is the mitigation | ADR-026 D7: migrate the 22 operator seats onto a daemon machine that is not a laptop (a small always-on VM or the cluster), `daemon install` shipped 09-06. **Careful: mint-rotate kills live seats — planned cutover, seat by seat** | Connectors (daemon) + Sharpen |
| A5 Backups exist, restore never drilled | `db-backup-restore.md` runbook; no drill record | One timed restore drill of Mongo + Postgres into a scratch namespace, recorded with RPO/RTO | Sharpen |
| A6 Error tracking not wired to a pager | `error-tracking.md` runbook exists | Backend 5xx rate and unhandled rejections alert at a threshold, not read from logs by hand | Sharpen |
| A7 Single points: LiteLLM, hosted runtime worker | one pod each; LiteLLM healthy 2d19h at last check | Health endpoints on both in the uptime set (A1); documented degradation (what stops when each is down) | Sharpen |

### B. Security and trust

| Gap | Evidence | Exit criterion | Lane |
|---|---|---|---|
| B1 Credential exposure through list/read endpoints | #1673's class: a leak masked by a 500 | A **probe-driven audit** of every list/read route that touches Integration, User, AgentCredential, RoomGrant: for stranger / member / owner / admin, assert no secret field in any 2xx body. Vera's two probes generalised into a test matrix in CI. Follow-up: `/api/auth/api-token` is metadata-only; generation is the only raw-token response (design note: `docs/plans/api-token-show-once-2026-09-12.md`). | Connectors (Vera) |
| B2 Webhook hardening backlog | audit 09-05: Slack no timestamp-freshness (replay) + no event_id dedup + missing secret → 500 not 401; GroupMe no verification/dedup; Discord no verification | Generalise `WebhookDelivery` claim-before-run to Slack/GroupMe/Discord; Slack freshness window; fail-closed 401s. Scoped 09-05, parked behind the daemon — un-park | Connectors |
| B3 Rate limits on every DB-touching handler | two CodeQL HIGHs this evening on new handlers | CodeQL stays a required check; a lint or test that new `router.*` handlers carry a limiter. **Landed as the jest guard** `backend/__tests__/unit/routes/routeRateLimitGuard.test.js` (#1682): every `router.<verb>` registration needs a limiter ahead of any auth middleware; pre-existing rows sit in `routeRateLimitGuard.baseline.json`, which may only shrink. **First shrink (follow-up PR):** the 11 `routes/agentsRuntime.ts` rows listed as `limiter-after-auth` — move `phase4RateLimit` ahead of `agentRuntimeAuth` / `dualAuth`, as the comment above that limiter already specifies, and delete their baseline rows | Connectors/Sharpen |
| B4 Terms of Service and Privacy Policy | no `/terms` or `/privacy` route | Both pages live and linked from signup, checkout and footer; a data-deletion path (account delete removes tokens, credentials, messages per retention rules) and an export | GTM (copy) + Sharpen (routes, deletion) — **Sam reads the text** |
| B5 Secrets hygiene | ESO-fed; personal tokens in smokes (A2) | No human credential in any automation path; quarterly rotation note in the runbook | Sharpen |

### C. First-run usability (the thing that decides day-2 return)

| Gap | Evidence | Exit criterion | Lane |
|---|---|---|---|
| C1 The funnel is not measured weekly | 49 signups / 30 d known only because someone ran a script today | A scheduled weekly report: signup → typed → got a reply → connected a channel → day-2 return → day-7 active, with the numbers in a pod, not a chat log. The script in this plan's appendix is the seed | GTM + Sharpen |
| C2 Hosted default caps at 1 agent | `DEFAULT_AGENTS_PER_USER = 1` | Decide the free/Pro split of hosted agents (D2) and make the cap the pricing table, not a beta constant | **Sam** |
| C3 Channel connect in < 2 minutes | Telegram proven; Slack/Discord install UX untested by a stranger; 6 connected channels total | One recorded stranger run per channel (Telegram, Slack, Discord) from the Connectors page, timed; fixes filed from the recording | Connectors + UX Lead gates |
| C4 The Tools page and approval card (pieces 3–4) | in flight tonight | Land #1667/#1670/#1669; then the same stranger run for "grant a tool → approve an action" | Connectors |
| C5 Empty states and the second visit | scripted starter workspace shipped 07-03; unmeasured since | C1's day-2 number decides whether this is a gap | GTM |

### D. Billing and packaging

| Gap | Evidence | Exit criterion | Lane |
|---|---|---|---|
| D1 Billing works | 4 active subscriptions, checkout/portal/webhook routes, tax-inclusive $12, retention respects paid tier (08-06 fix) | Keep; add a dunning check: failed renewal → grace → downgrade, tested with Stripe test clocks | Sharpen |
| D2 What Pro gates is under-defined | copy: "unlimited history, Community listing and hosted agents" vs cap constant of 1 | A one-page pricing table that the code's caps read from: free = N hosted agents / turns, Pro = M; history window; listing. Copy and constants agree (pricing copy is a promise — 08-06) | **Sam** decides, GTM writes, Sharpen wires |
| D3 "Free in beta" badge | memory 08-06 | Decide the end of beta date or the trigger (e.g., A1+A2+B4 done) | **Sam** |
| D4 Receipts, invoices, VAT fields | Stripe portal covers most | Verify the portal shows invoices; add company/VAT fields at checkout if we sell to teams | GTM |

### E. Support and go-to-market readiness

| Gap | Evidence | Exit criterion | Lane |
|---|---|---|---|
| E1 No support path in product | no support address in copy | One address (support@) that lands in a pod the fleet watches (the HQ support seat exists) plus a human SLA statement (e.g., 1 business day) | GTM |
| E2 No status page | none | Public status page fed by A1 (Uptime Kuma pages are free) linked from footer | Sharpen |
| E3 No changelog | none public | A `/changelog` fed from merged PR titles weekly (GTM session already drafts) | GTM |
| E4 Sales collateral | pricing page exists; SkyDeck deck exists in the GTM repo | A one-pager and a 3-minute recorded demo of steps 1–3 of §2, refreshed when the Tools page lands | GTM |
| E5 Reference customers | 4 paying users | Ask each of the 4 for a 20-minute call; two quotes with permission | **Sam** |

### F. Legal minimum

ToS + Privacy (B4), a data-processing note for teams, cookie/analytics disclosure if analytics are added, OAuth apps stay on non-sensitive scopes (07-03 decision) so no verification review is triggered.

---

## 4. Sequence — four milestones, each with an exit test

**M0 — Stop depending on people (this week).** A1 alerting + status page, A2 service identity for smokes, A3 admin cap, B1 audit matrix started, un-park B2. *Exit:* a deploy runs and smokes green with every human token expired; an outage pages a phone within 5 minutes (tested by killing the backend pod).

**M1 — Safe to trust (next two weeks).** B1 matrix green in CI, B2 webhooks fail-closed and deduped on all four providers, B4 ToS/Privacy/deletion live, A5 restore drill, A4 fleet off the laptop begins. *Exit:* a stranger's tokens cannot be read by another user on any route (matrix), and account deletion removes them (test).

**M2 — Measured and packaged (weeks 3–4).** C1 weekly funnel report running, C3 three timed channel runs done and fixes landed, D2 pricing table wired to caps, D3 beta end decided, E1 support path, E3 changelog. *Exit:* the weekly report shows signup → reply → channel → day-2 as four numbers, and the pricing page and the code disagree on nothing.

**M3 — Sell (week 5+).** E4 collateral and demo, E5 references, D4 team fields, the Tools page and approval card in the demo. *Exit:* Sam can send a stranger the pricing page and a demo link and nothing in this document is still red.

Distribution (the ~1.6 signups/day) is the GTM plan's problem, not this document's; this document makes sure that when distribution works, what arrives is sellable.

---

## 5. Decisions — made 2026-09-12 by delegation ("decide for me")

Sam delegated these on 2026-09-12; each is the reversible option, and each can be re-opened by Sam with one line in the connector pod.

1. **D2 free-vs-Pro hosted split:** free = 1 hosted agent, 200 turns/day (today's constants, now the free row of the pricing table); Pro = 3 hosted agents, 1,000 turns/day, unlimited history, Community listing. The constants read from one table that the pricing page copy is generated from, so they cannot disagree. **D3 beta end:** a trigger, not a date — the "Free in beta" badge comes off when M0 and M1 exit tests both pass.
2. **B4 ToS/Privacy:** GTM drafts both from a standard SaaS template naming the actual data flows (tokens, messages, retention windows, third-party model providers); the delegate reviews for accuracy against the code; **Sam still reads the final text once** — a legal document under the company's name is the one thing this delegation does not cover.
3. **A4 fleet location:** a small always-on VM (2 vCPU / 8 GB class) as the daemon machine, not the cluster (seats need local CLIs and the operator's model logins; the cluster's spot pool can reclaim with 30 s notice). Cutover seat by seat, never in bulk, because the mint-rotate path kills a live seat; the operator laptop stays registered as a second machine.
4. **E5 references:** ask all four paying users, not a subset — the ask is cheap and the answer is data.
5. **A1 who alerts page:** Sam's phone AND the Sharpen commander seat's pod, so a fleet seat can act on the ones a person would sleep through; anything unresolved after 15 minutes re-pages Sam.

## Appendix — the measurement (re-run weekly; read-only)

Run inside the backend pod against production Mongo. It produced §1's table.

```js
// node -e in the backend container; all reads.
const d = (n) => new Date(Date.now() - n * 864e5);
const humans = { isBot: { $ne: true } };
humans_total   = User.countDocuments(humans)
signups_30d    = User.countDocuments({ ...humans, createdAt: { $gte: d(30) } })
active_7d      = User.countDocuments({ ...humans, lastActive: { $gte: d(7) } })   // lastActive, never lastLogin
pro            = User.countDocuments({ 'entitlements.pro': true })
billing_active = User.countDocuments({ 'billing.subscriptionStatus': 'active' })
installs_by_runtime = AgentInstallation.aggregate([{ $match: { status: 'active' } },
                       { $group: { _id: '$config.runtime.runtimeType', n: { $sum: 1 } } }])
integrations   = Integration.aggregate([{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }])
machines       = Machine.countDocuments({})
```

The next version adds the two funnel steps this script cannot see from Mongo alone: "got a reply" (Postgres `messages` ledger, agent-authored row in the user's pod after their first message) and "day-2 return" (`lastActive` ≥ createdAt + 1 d).
