# Docs wash — inventory (2026-09-19)

Every file in `README.md`, `docs-site/` (including `docs.json`), and `docs/` gets an owner and a verdict (keep, rewrite, or delete) before any rewrite starts. This is the first deliverable of the docs-wash charter, and the table below is its source of truth. A rewrite PR that touches a file not listed here, or contradicts the verdict listed here, should be sent back.

**Measured at:** `main` @ `bd801882`. **CLI reference:** `@commonlyai/cli@0.1.58` (`npm view` = 0.1.58), installed clean into a scratch dir. The operator's `commonly` on PATH is a worktree symlink at 0.1.56, so it doesn't count as the consumer. **Route reference:** the live `https://api.commonly.me`.

## Tally

| surface | files | keep | rewrite | delete |
|---|---|---|---|---|
| `README.md` | 1 | 0 | 1 | 0 |
| `docs-site/` | 30 | 9 | 21 | 0 |
| `docs/` | 195 | 107 | 48 | 40 |
| **total** | **226** | **116** | **70** | **40** |

Keeps split three ways: **13** current-state docs whose CLI commands and routes were checked against the consumer, **29** current-state docs with no CLI or route claim to check (prose, not fact-checked here), **74** records (ADRs, audits, dated plans, the AX log) kept as history, not as current-state claims.

Lines: keep 26,537 · rewrite 14,011 · delete 11,251.

## What changed from the charter's numbers

The charter measured at `03597262`. I re-measured at `bd801882`, and four of its figures don't reproduce. The wash should use these:

| claim | charter | measured | note |
|---|---|---|---|
| `docs/` files mentioning moltbot/openclaw | 76 | **76** (86 with `clawdbot`) | `grep -rliE 'moltbot\|openclaw'`. The 10 extra `clawdbot`-only files are the same dead concept. |
| `docs/` files on the dead `app-dev`/`api-dev` hostnames | 17 | **17** | The pattern was too narrow. Two more hosts answer with a bare nginx 404: `litellm-dev.commonly.me` (LITELLM.md ×2, litellm-claude-code.md ×1) and `app.commonly.me` (CAP.md ×2, inside a `commonly login --instance` command — the sharpest case — and DEPLOYMENT.md ×1). Live: `commonly.me` (frontend), `api.commonly.me` (API). Counted at the inventory's own measurement point, `bd801882`. Fixed in #1785 (merged) and #1787/#1791/#1788. The remaining hits are records (`domain-migration-commonly-me.md`, `retention-traction-onboarding-2026-07.md`), which describe the migration and stay as written. |
| `docs/` files mentioning Gemini | 26 | **33** case-insensitive, 22 capitalised | Neither regex gives 26. |
| `docs/` files on the "old attach flow" | 21 | **21** for `agent attach` | Ruled daemon-first (finding 1): 8 rewrite, 1 delete, 12 records. |
| docs-site nav groups | 3 | **5** in the Docs tab, plus an API Reference tab | `docs-site/docs.json`. |
| docs-site screenshots | "0 referenced, 7 unused" | **4 screenshots, all referenced** (5 refs) | The other 3 images are the logos and favicon, which `docs.json` references. The README draws on a separate `screenshots/` directory: 21 files, 4 referenced, 13 referenced nowhere. See **Images**. |

## Findings that change the plan

1. **Attach: ruled daemon-first (Sam, 2026-09-19, card `6aaeeb09`).** The wash teaches `commonly daemon install` as the way in. `agent attach` stays documented as the manual path until a CLI PR drops it, because 0.1.58's `--help` still opens with it. The charter's "old attach flow" means the pre-daemon `nohup commonly agent run` loop and the stale flags and hostnames around it. Of the 21 `docs/` files that mention `agent attach`: 8 current-state docs re-tag to **rewrite to daemon-first**, 1 was already a delete, and 12 are records (4 ADRs, 3 dated plans, 4 audits, and the `codex-in-gateway-pod` runbook). The records stay as history. `README.md` and `docs-site/agents/connect.mdx` also re-tag.
2. **openclaw is gone from the cluster but not from the CLI.** `kubectl get deploy -n commonly-dev` shows no `clawdbot-gateway` (backend, commonly-bot, frontend, litellm, redis, cloud-codex-cody only). `commonly dev clawdbot` still ships in 0.1.58 ("Bootstrap local OpenClaw gateway config"). Docs that describe the gateway get deleted. Docs that only name it get rewritten. The leftover CLI subcommand is a CLI follow-up, not a docs one.
3. **Six CLI commands cited in the docs don't exist under the parent the docs name in 0.1.58.** Two need a parent fix, not a new command: `install` ships as `commonly daemon install` and `dev` ships as the top-level `commonly dev` (Kai's measurement). The other four exist nowhere: `agent update`, `agent sdk-path`, `agent rotate-token`, `pod join`. Every file citing any of the six is marked rewrite.
4. **Routes: 337 distinct cited, 71 not served live.** I probed each cited route with its documented method, with no auth. The backend answers `Cannot <METHOD> <path>` only when no route matches, so a 401 or 400 means the route exists. 240 routes are live. 8 are webhook or billing routes, which I skipped rather than POST into production. 18 are bare mount roots or prefixes (`/api/agents/runtime/`), which aren't routes on their own. The dead list is at the bottom. The worst front-door case is `/api/docs`. The README and 8 docs-site pages cite it as *the* API reference, but no API reference is served there. `server.ts:231` mounts it in every env, `/api/docs` itself returns `Cannot GET`, and its only route, `/api/docs/backend`, returns 500 `Unable to load documentation` live (Vera's correction, re-probed 2026-09-19). Kai traced the 500 to a dead path constant in `docs.ts`: it reads `backend/docs/BACKEND.md`, but the file lives at `docs/development/BACKEND.md`. Fixing the path would serve an internal dev doc, which is still not an API reference. Whether Commonly publishes one is the paused CAP OpenAPI track (ADR-011) and is Sam's call. **No writer points at `/api/docs` until that exists.**
5. **Gemini is still wired into the backend.** `llmService`, `vectorSearchService`, `podContextService`, and the provisioners still read `GEMINI_API_KEY`. The 33 docs that mention it get rewritten to say what the backend actually does now (LiteLLM-routed). They are not deleted as if the concept were gone.
6. **docs-site has no page for what exists now.** Nothing covers connectors or grants (`/api/grants`, `/api/credentials` are live), the daemon or seats (`/api/machines`, `commonly daemon *`), or the pi, claude, and codex adapters. The nav restructure adds those pages. It's a separate PR from the rewrites below.
7. **Deletes break inbound links.** The *why* column lists each delete target's inbound references outside the delete set, so the delete PR can fix them in the same diff. That includes one code comment (`backend/routes/registry/presets.ts` → `AGENT_CODING_CAPABILITY.md`) and one `docs/README.md` index that links to seven delete targets. The runtime reads `docs/skills/awesome-agent-skills-index.json`, so deletes must stay on `.md` files. The inbound search covers `.tsx` and `.sh` too. Two consumer-facing refs are an admin-UI string (`GlobalIntegrations.tsx:1050` → `CODEX_OAUTH_SETUP.md`) and a red smoke-test result (`scripts/smoke-test-demo.sh:466` → `demo-verification.md`), both caught by Wren. Separately, `scripts/test-discord.sh:44` points at `docs/design/DISCORD_INTEGRATION.md`, a path that has never existed. That link was already broken before this wash and isn't in any row.

## Owners

The owner sets don't overlap. Each writer touches only the rows that carry its name, and nothing outside this table.

- **quill**: `README.md` only.
- **folio**: every `docs-site/` rewrite row, including `docs-site/docs.json` for the nav restructure. The new connector, grant, daemon and adapter pages that restructure adds are folio's too.
- **quire**: every `docs/` rewrite row. Runbooks and integration guides go first.
- **otto**: supervisor and verifier. Owns every delete row, which waits for this PR to merge, plus the orphan screenshots (17 of them; see Images). Clears writer PRs, and re-verifies keeps at each CLI publish.
- **Sam**: ADR status wording. ADRs are records and don't get rewritten. ADR-021 supersedes only ADR-010's Phase 2+ track (and the moltbot rows of CLAUDE.md's runtime table). The other ADRs that name openclaw lost a driver, not their decision.

Work items by owner (rewrite + delete + ADR status lines): quire 48, otto 40, folio 21, quill 1, Sam 1.

## Method: how a verdict was reached

- **keep, verified:** 0 rot hits, every `commonly …` command cited is registered in 0.1.58, and every cited route is served live.
- **keep, prose:** 0 rot hits and no CLI or route claim to check. The table says "prose only". I didn't fact-check these beyond relative links.
- **keep, record:** ADRs, audits, dated plans, and the AX log. These are history. Nobody should read them as current state.
- **rewrite:** the subject is current, but the file has rot hits, cites a command 0.1.58 lacks, cites a route that isn't served live, teaches `agent attach` as the way in (now daemon-first), or shows an image that carries a retired concept (image column).
- **delete:** the subject itself is gone (retired gateway, never-shipped integrations, pre-ADR strategy drafts superseded by the ADR series, Jan–Feb plans that shipped or were abandoned). Git keeps the history.

Relative links were checked in all 226 rows: 6 are broken, and the table lists them.

## Images

This section sits outside the tally above, which counts docs only. The 8 page images get removed inside their page's rewrite PR; the orphans went in #1803 (merged).

The first cut of this inventory counted only `docs-site/images/`, and that missed the README's source. The README pulls its screenshots from the root `screenshots/` directory (21 files). Wren read every image that the docs surfaces show (#1781 review). The problem is in the pixels, not just a missing harness stamp: they show the retired concepts.

| image | referenced by | what it shows (wren) | verdict |
|---|---|---|---|
| `screenshots/real-engineering.png` | `README.md` | a Theo/Nova/Cody room | **delete** now; replace from the harness last |
| `screenshots/your-team.png` | `README.md` | OPENCLAW badges on 12 of 15 cards, plus a "+ Hire an agent" button | **delete** now; replace from the harness last |
| `screenshots/agent-identity.png` | `README.md` | Theo tagged OPENCLAW | **delete** now; replace from the harness last |
| `screenshots/real-artifacts.png` | `README.md` | not singled out by wren; not a harness capture | **delete** with the README rewrite; replace from the harness last |
| `docs-site/images/home-landing.png` | `introduction.mdx` | hero reads "One memory for Codex" | **delete** now; replace from the harness last |
| `docs-site/images/agents.png` | `concepts/agents.mdx` | OPENCLAW badges | **delete** now; replace from the harness last |
| `docs-site/images/dev-team-chat.png` | `introduction.mdx`, `concepts/pods.mdx` | a Theo/Nova/Cody room | **delete** now; replace from the harness last |
| `docs-site/images/pods-browse.png` | `introduction.mdx` | not a harness capture | **delete** with the intro rewrite; replace from the harness last |
| 17 others in `screenshots/` (`agent-dm`, `agents`, `current`, `demo-poster.jpg`, `dev-team-chat`, `feed`, `feed-fresh`, `home-landing`, `landing`, `login`, `pod-chat`, `pod-chat-fresh`, `pods`, `pods-browse`, `task-board`, `team-pods`, `team-pods-fresh`) | nothing (path-qualified `git grep` finds no reference anywhere in the repo) | — | **delete** (#1803) |
| `docs-site/logo/*`, `docs-site/favicon.png`, `frontend/src/assets/commonly-logo.png` | `docs.json`, `README.md` | brand marks | **keep** |
| `docs/design/evidence/*.png` | the PRs and design notes that cite them | harness evidence | **keep** as records |

Corrected 2026-09-20: this section first said 13 orphans. Four more — `agents`, `dev-team-chat`, `home-landing`, `pods-browse` — share a basename with the `docs-site/images/` copies, and a basename grep credited them with the `.mdx` pages' references; those pages reference `/images/…`, the docs-site files. **Path-qualify every reference check**: the same trap inflated a link sweep from 0 real hits to 37, because several surviving files are also named `README.md`.

The rule this adds: an image that shows a retired concept is removed in the same rewrite PR that touches its page. That page ships without a picture until the harness phase. A stale screenshot teaches the wrong product faster than any paragraph can, and "screenshots last" governs when new pixels get added. It is not a reason to keep old ones up. Image deletes belong to the page's writer (quill for the README, folio for docs-site), and the table's image column carries them; the 13 unreferenced files go in otto's delete PR.

## Full inventory

| path | lines | last touched | owner | verdict | why | image (wren) |
|---|---|---|---|---|---|---|
| `README.md` | 395 | 2026-08-24 | quill | **rewrite** | cites /api/docs as the API reference, but none is served there; top half already assigned — openclaw 19x; gemini 2x; attach 1x | real-engineering, your-team, agent-identity (OPENCLAW badges, Theo/Nova/Cody rooms); real-artifacts not harness — delete all 4 |
| `docs-site/agents/authentication.mdx` (nav) | 68 | 2026-04-02 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/agents/connect.mdx` (nav) | 118 | 2026-08-30 | folio | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; openclaw 2x; attach 1x |  |
| `docs-site/agents/events.mdx` (nav) | 220 | 2026-09-01 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 1 route(s) served live |  |
| `docs-site/agents/memory.mdx` (nav) | 105 | 2026-09-01 | folio | **rewrite** | cites /api/v1/pods/:id/memory/:file, not served live — openclaw 1x; 1/1 cited routes not served live |  |
| `docs-site/agents/overview.mdx` (nav) | 65 | 2026-07-04 | folio | **rewrite** | cites POST /api/pods/:id/messages + /api/v1/pods/:id/memory, neither served live — openclaw 1x; 2/11 cited routes not served live |  |
| `docs-site/agents/runtime-protocol.mdx` (nav) | 160 | 2026-09-01 | folio | **rewrite** | openclaw 1x |  |
| `docs-site/agents/tools.mdx` (nav) | 75 | 2026-04-02 | folio | **rewrite** | openclaw 1x |  |
| `docs-site/api-reference/agents.mdx` (nav) | 10 | 2026-04-02 | folio | **rewrite** | stub: points at /api/docs, where no API reference is served (only route /backend 500s live), and at the v1.0.x branch spec |  |
| `docs-site/api-reference/authentication.mdx` (nav) | 10 | 2026-04-02 | folio | **rewrite** | stub: points at /api/docs, where no API reference is served (only route /backend 500s live), and at the v1.0.x branch spec |  |
| `docs-site/api-reference/events.mdx` (nav) | 10 | 2026-04-02 | folio | **rewrite** | stub: points at /api/docs, where no API reference is served (only route /backend 500s live), and at the v1.0.x branch spec |  |
| `docs-site/api-reference/introduction.mdx` (nav) | 57 | 2026-07-04 | folio | **rewrite** | cites /api/docs as the reference; no API reference is served there |  |
| `docs-site/api-reference/messages.mdx` (nav) | 10 | 2026-04-02 | folio | **rewrite** | stub: points at /api/docs, where no API reference is served (only route /backend 500s live), and at the v1.0.x branch spec |  |
| `docs-site/api-reference/pods.mdx` (nav) | 10 | 2026-04-02 | folio | **rewrite** | stub: points at /api/docs, where no API reference is served (only route /backend 500s live), and at the v1.0.x branch spec |  |
| `docs-site/api-reference/tasks.mdx` (nav) | 10 | 2026-04-02 | folio | **rewrite** | stub: points at /api/docs, where no API reference is served (only route /backend 500s live), and at the v1.0.x branch spec |  |
| `docs-site/concepts/agents.mdx` (nav) | 101 | 2026-07-04 | folio | **rewrite** | openclaw 1x | agents.png (OPENCLAW badges) — delete |
| `docs-site/concepts/pods.mdx` (nav) | 86 | 2026-08-21 | folio | **rewrite** | cites POST /api/v1/pods/:id/memory/:file, not served live — 1/3 cited routes not served live | dev-team-chat (Theo/Nova/Cody room) — delete |
| `docs-site/concepts/task-board.mdx` (nav) | 81 | 2026-08-21 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/deployment/docker.mdx` (nav) | 88 | 2026-08-24 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/deployment/environment-variables.mdx` (nav) | 62 | 2026-09-01 | folio | **rewrite** | gemini 2x |  |
| `docs-site/deployment/kubernetes.mdx` (nav) | 111 | 2026-08-24 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/deployment/production-checklist.mdx` (nav) | 16 | 2026-08-24 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/integrations/discord.mdx` (nav) | 38 | 2026-04-02 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/integrations/github.mdx` (nav) | 48 | 2026-08-21 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 4 route(s) served live |  |
| `docs-site/integrations/webhooks.mdx` (nav) | 26 | 2026-09-01 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 1 route(s) served live |  |
| `docs-site/introduction.mdx` (nav) | 72 | 2026-08-21 | folio | **rewrite** | no text rot, but the hero image is the retired Codex-memory landing (see image column); no pods/seats/connectors/daemon framing | home-landing ("One memory for Codex"), dev-team-chat (Theo/Nova/Cody), pods-browse — delete all 3 |
| `docs-site/marketplace/manifest.mdx` (nav) | 57 | 2026-04-02 | folio | **rewrite** | openclaw 2x |  |
| `docs-site/marketplace/overview.mdx` (nav) | 46 | 2026-04-02 | folio | **rewrite** | openclaw 1x |  |
| `docs-site/marketplace/publishing.mdx` (nav) | 45 | 2026-04-02 | folio | **rewrite** | openclaw 1x |  |
| `docs-site/quickstart.mdx` (nav) | 82 | 2026-08-24 | folio | **rewrite** | cites /api/docs (no API reference served); no daemon or connector step |  |
| `docs/AGENT_AVATARS.md` | 183 | 2026-07-02 | quire | **rewrite** | gemini 11x |  |
| `docs/CODEX_OAUTH_SETUP.md` | 147 | 2026-07-03 | otto | **delete** | superseded by in-cluster device-auth (litellm codex-cli sidecar); gateway-era — inbound refs to fix: `frontend/src/components/admin/GlobalIntegrations.tsx` |  |
| `docs/COMMONLY_SCOPE.md` | 745 | 2026-04-12 | quire | **rewrite** | openclaw 3x |  |
| `docs/DEMO_QUICKSTART.md` | 339 | 2026-08-24 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; attach 2x |  |
| `docs/LOCAL_CLAUDE_CODE_DEMO.md` | 166 | 2026-08-24 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 1 route(s) served live |  |
| `docs/MCP_INTEGRATION.md` | 314 | 2026-09-01 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; openclaw 3x; attach 1x — broken link(s): `./adr/ADR-012-memory-propagation.md` |  |
| `docs/README.md` | 106 | 2026-08-24 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/SELF_HOSTING.md` | 9 | 2026-08-24 | otto | **keep** | redirect stub to deployment/SELF_HOSTED.md; links resolve |  |
| `docs/SUMMARIZER_AND_AGENTS.md` | 357 | 2026-08-01 | quire | **rewrite** | openclaw 12x; clawdbot 1x; gemini 2x |  |
| `docs/adr/ADR-001-installable-taxonomy.md` | 447 | 2026-09-11 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-002-attachments-and-object-storage.md` | 366 | 2026-04-19 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-003-memory-as-kernel-primitive.md` | 337 | 2026-08-29 | Sam | **keep** | record, not a current-state claim: decision record — names the retired openclaw driver (ADR-021); decision stands; status wording is Sam's |  |
| `docs/adr/ADR-004-commonly-agent-protocol.md` | 354 | 2026-09-01 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-005-local-cli-wrapper-driver.md` | 330 | 2026-08-01 | Sam | **keep** | record, not a current-state claim: decision record — names the retired openclaw driver (ADR-021); decision stands; status wording is Sam's |  |
| `docs/adr/ADR-006-webhook-sdk-and-self-serve-install.md` | 262 | 2026-08-04 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-007-ecosystem-integration-strategy.md` | 400 | 2026-08-29 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-008-agent-environment-primitive.md` | 248 | 2026-04-27 | Sam | **keep** | record, not a current-state claim: decision record — names the retired openclaw driver (ADR-021); decision stands; status wording is Sam's |  |
| `docs/adr/ADR-009-test-tiers-and-ci-cd-to-gke.md` | 215 | 2026-04-30 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-010-commonly-mcp-server.md` | 320 | 2026-09-01 | Sam | **keep** | record, not a current-state claim: decision record — Phase 2+ track superseded by ADR-021 (the only ADR it supersedes); status wording is Sam's |  |
| `docs/adr/ADR-011-shell-first-pre-gtm.md` | 127 | 2026-04-30 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-012-memory-propagation-and-injection.md` | 622 | 2026-08-05 | Sam | **keep** | record, not a current-state claim: decision record — names the retired openclaw driver (ADR-021); decision stands; status wording is Sam's |  |
| `docs/adr/ADR-013-agent-file-production-and-skill-bundles.md` | 778 | 2026-08-04 | Sam | **keep** | record, not a current-state claim: decision record — names the retired openclaw driver (ADR-021); decision stands; status wording is Sam's |  |
| `docs/adr/ADR-014-cloud-codex-runtime-and-shared-auth-surface.md` | 104 | 2026-06-09 | Sam | **keep** | record, not a current-state claim: decision record — names the retired openclaw driver (ADR-021); decision stands; status wording is Sam's |  |
| `docs/adr/ADR-015-spot-pool-for-stateless-workloads.md` | 177 | 2026-07-12 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-016-pod-model-and-visibility.md` | 289 | 2026-08-05 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-017-attention-routing.md` | 554 | 2026-09-11 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-018-agent-attention-claims.md` | 416 | 2026-08-26 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-019-a2a-conversation-lifecycle.md` | 192 | 2026-08-12 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-020-admin-guide-delegated-authority.md` | 153 | 2026-09-01 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-021-pi-turn-engine-and-openclaw-retirement.md` | 144 | 2026-08-13 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-022-persona-colleagues.md` | 323 | 2026-08-15 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-023-agent-runtime-substrate.md` | 97 | 2026-08-30 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-024-shared-awareness-and-the-agent-inbox.md` | 332 | 2026-09-02 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-025-connector-substrate.md` | 584 | 2026-09-03 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-026-local-agent-daemon.md` | 174 | 2026-09-07 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-027-pm-tool-projection-contract.md` | 283 | 2026-09-03 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-028-work-claims-and-decision-ledger.md` | 722 | 2026-09-01 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-029-attention-delegate.md` | 83 | 2026-09-03 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/adr/ADR-030-agent-identity.md` | 101 | 2026-09-01 | Sam | **keep** | record, not a current-state claim: decision record |  |
| `docs/agents/AGENT_AUTONOMY.md` | 222 | 2026-03-26 | quire | **rewrite** | autonomy model still real; mechanics described are gateway-era — clawdbot 4x |  |
| `docs/agents/AGENT_CODING_CAPABILITY.md` | 105 | 2026-07-01 | otto | **delete** | describes acpx_run inside the retired gateway — inbound refs to fix: `README.md`, `backend/routes/registry/presets.ts`, `docs/agents/README.md`, `docs/runbooks/codex-in-gateway-pod.md` |  |
| `docs/agents/AGENT_RUNTIME.md` | 853 | 2026-07-22 | quire | **rewrite** | openclaw 46x; clawdbot 26x; gemini 2x |  |
| `docs/agents/BUILDING_AN_AGENT.md` | 67 | 2026-04-12 | quire | **rewrite** | openclaw 2x; clawdbot 2x |  |
| `docs/agents/CLAWDBOT.md` | 683 | 2026-06-29 | otto | **delete** | subject retired (ADR-021); no clawdbot-gateway deployment live — inbound refs to fix: `docs/agents/BUILDING_AN_AGENT.md`, `docs/agents/NATIVE_RUNTIME.md`, `docs/agents/README.md`, `docs/deployment/DEPLOYMENT.md`, `docs/development/local-credentials.md`, `docs/runbooks/clawdbot-gateway-config-crashloop.md` |  |
| `docs/agents/COMMONLY_MCP.md` | 163 | 2026-08-26 | quire | **rewrite** | openclaw 7x |  |
| `docs/agents/CONNECTING_LOCAL_AGENTS.md` | 95 | 2026-07-05 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; attach 1x |  |
| `docs/agents/LOCAL_CLI_WRAPPER.md` | 224 | 2026-08-29 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; deadhost 1x; gemini 2x; attach 2x |  |
| `docs/agents/NATIVE_RUNTIME.md` | 175 | 2026-04-12 | quire | **rewrite** | openclaw 2x; clawdbot 2x |  |
| `docs/agents/README.md` | 75 | 2026-09-19 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; openclaw 7x; clawdbot 5x; attach 1x |  |
| `docs/agents/WEBHOOK_SDK.md` | 163 | 2026-08-30 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; deadhost 4x; attach 1x |  |
| `docs/agents/clawdbot-pin-and-the-cycles-outage.md` | 52 | 2026-08-18 | otto | **keep** | record, not a current-state claim: incident write-up; CLAUDE.md points at it |  |
| `docs/agents/daemon-seat-state-surfaces.md` | 171 | 2026-09-19 | otto | **keep** | 0 rot; verified 1 CLI cmd(s) in 0.1.58 + 2 route(s) served live |  |
| `docs/agents/pi-adapter.md` | 129 | 2026-09-19 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; attach 1x |  |
| `docs/agents/public-facing-agent-sandboxing.md` | 79 | 2026-07-21 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/agents/skills/commonly/SKILL.md` | 219 | 2026-09-07 | otto | **keep** | 0 rot; verified 1 CLI cmd(s) in 0.1.58 + 0 route(s) served live |  |
| `docs/ai-features/AI_FEATURES.md` | 394 | 2026-04-06 | quire | **rewrite** | gemini 6x |  |
| `docs/ai-features/DAILY_DIGESTS.md` | 533 | 2026-04-06 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 4 route(s) served live |  |
| `docs/ai-features/README.md` | 26 | 2026-02-06 | quire | **rewrite** | gemini 1x |  |
| `docs/ai-features/VISUALIZATION_ROADMAP.md` | 240 | 2026-01-22 | otto | **delete** | January roadmap, never scheduled — inbound refs to fix: `docs/ai-features/README.md` |  |
| `docs/architecture/ARCHITECTURE.md` | 151 | 2026-02-01 | quire | **rewrite** | 1/3 cited routes not served live |  |
| `docs/architecture/CAP.md` | 190 | 2026-04-06 | quire | **rewrite** | 6/6 cited routes not served live; docs/openapi/cap-kernel.yaml + ADR-004 are canon — openclaw 7x; gemini 1x; 6/6 cited routes not served live |  |
| `docs/architecture/CLAUDE_CODE_AGENT.md` | 193 | 2026-04-02 | quire | **rewrite** | 6/7 cited routes not served live; claude adapter is current (attach claude) — deadhost 2x; 6/7 cited routes not served live |  |
| `docs/architecture/CLI.md` | 223 | 2026-04-02 | quire | **rewrite** | openclaw 1x |  |
| `docs/architecture/README.md` | 19 | 2026-01-22 | quire | **rewrite** | gemini 1x |  |
| `docs/architecture/WEBHOOK_RUNTIME.md` | 218 | 2026-04-02 | quire | **rewrite** | openclaw 1x |  |
| `docs/audits/2026-05-24-phase-3/openclaw-moltbot-workspace-audit.md` | 35 | 2026-05-24 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/TASK-007-gh-43-ci-cd-iteration-1-required-checks-and-workflow-gaps.md` | 18 | 2026-04-03 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/TASK-011-frontend-ux-audit.md` | 18 | 2026-04-05 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/TASK-024-credential-audit.md` | 109 | 2026-04-05 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/FINDINGS.md` | 84 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/huddle-observations.md` | 636 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/landing-v2-proposal.md` | 56 | 2026-06-01 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/local-agent-runtimes-verified.md` | 120 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/marketplace-v2-gaps.md` | 40 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/settings-v2-gaps.md` | 51 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/audits/ui-smoke-2026-05-23/walkthrough-2026-05-23.md` | 48 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/cli/README.md` | 275 | 2026-04-16 | quire | **rewrite** | rewrite to daemon-first: teaches `agent attach` as the way in; deadhost 6x; attach 4x |  |
| `docs/commonly-vs-alternatives.md` | 94 | 2026-07-27 | otto | **keep** | record, not a current-state claim: positioning page; prose only |  |
| `docs/database/DATABASE.md` | 430 | 2026-02-01 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 1 route(s) served live |  |
| `docs/database/POSTGRESQL_MIGRATION.md` | 195 | 2026-01-29 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/database/README.md` | 19 | 2026-01-22 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/demo-verification.md` | 275 | 2026-05-12 | otto | **delete** | May demo checklist on dead hostnames + gateway — inbound refs to fix: `docs/runbooks/local-ui-render-harness.md`, `scripts/recover-codex-auth.sh`, `scripts/smoke-test-demo.sh` |  |
| `docs/deployment/DEPLOYMENT.md` | 646 | 2026-08-24 | quire | **rewrite** | openclaw 4x; clawdbot 14x; deadhost 2x; gemini 5x |  |
| `docs/deployment/GCP_MIGRATION.md` | 441 | 2026-03-04 | otto | **delete** | one-time migration log (March); names retired gateway 29x |  |
| `docs/deployment/GITHUB_DEPLOY_SETUP.md` | 277 | 2026-04-30 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/deployment/K8S_DEPLOYMENT_CHECKLIST.md` | 282 | 2026-07-03 | quire | **rewrite** | clawdbot 2x; gemini 1x — broken link(s): `../ARCHITECTURE.md` |  |
| `docs/deployment/KUBERNETES.md` | 518 | 2026-07-03 | quire | **rewrite** | openclaw 11x; clawdbot 9x; gemini 2x |  |
| `docs/deployment/README.md` | 29 | 2026-08-24 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/deployment/SELF_HOSTED.md` | 96 | 2026-08-24 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/design/AGENT_DISTRIBUTION_PLATFORM.md` | 527 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it — inbound refs to fix: `docs/design/marketplace-publish-fork.md` |  |
| `docs/design/AGENT_MEMORY_SCOPES.md` | 96 | 2026-05-02 | otto | **delete** | superseded by ADR-003 / ADR-012 — inbound refs to fix: `README.md` |  |
| `docs/design/AGENT_ORCHESTRATOR.md` | 139 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/COMMONLY_AS_CONTEXT_HUB.md` | 552 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/EXECUTIVE_SUMMARY.md` | 278 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/HYBRID_SOCIAL_PLATFORM.md` | 479 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/MCP_APPS.md` | 37 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/MULTI_AGENT_POSITIONING.md` | 47 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/MULTI_AGENT_ROADMAP.md` | 44 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/MVP_COMPETITIVE_STRATEGY.md` | 756 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/POD_SKILLS_INDEX.md` | 213 | 2026-05-02 | otto | **delete** | pre-ADR draft; skills shipped differently |  |
| `docs/design/SOCIAL_PLATFORM_FOR_AI_AGENTS.md` | 397 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/UI_UX_ROADMAP.md` | 471 | 2026-05-02 | otto | **delete** | pre-ADR strategy draft, superseded by the ADR series; git keeps it |  |
| `docs/design/agent-status-honesty.md` | 212 | 2026-08-12 | otto | **keep** | record, not a current-state claim: design record for shipped status surface |  |
| `docs/design/brand-direction.md` | 138 | 2026-08-22 | otto | **keep** | record, not a current-state claim: design record; Gemini is image-tool provenance, not product |  |
| `docs/design/marketplace-publish-fork.md` | 964 | 2026-05-02 | otto | **keep** | record: design for the shipped /api/marketplace backend — openclaw 3x |  |
| `docs/design/shell-craft-audit-2026-08-22.md` | 96 | 2026-08-22 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/design/signal-identity.md` | 96 | 2026-09-15 | otto | **keep** | record, not a current-state claim: design record (2026-09-15) |  |
| `docs/design/signal-recovery-2026-09-07.md` | 123 | 2026-09-07 | otto | **keep** | record, not a current-state claim: dated audit |  |
| `docs/design/threading-surface-ruling.md` | 58 | 2026-08-22 | otto | **keep** | record, not a current-state claim: ruling record |  |
| `docs/development/BACKEND.md` | 652 | 2026-02-14 | quire | **rewrite** | openclaw 18x; deadhost 1x; gemini 7x — broken link(s): `./DEPLOYMENT.md` |  |
| `docs/development/FRONTEND.md` | 273 | 2026-08-22 | quire | **rewrite** | openclaw 4x — broken link(s): `./DEPLOYMENT.md` |  |
| `docs/development/LINTING.md` | 93 | 2026-01-22 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/development/LITELLM.md` | 582 | 2026-06-25 | quire | **rewrite** | openclaw 7x; clawdbot 2x; gemini 12x |  |
| `docs/development/README.md` | 39 | 2026-08-04 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/development/agent-experience-audit.md` | 3793 | 2026-09-18 | otto | **keep** | record, not a current-state claim: append-only AX log; history is the point |  |
| `docs/development/local-credentials.md` | 161 | 2026-05-23 | quire | **rewrite** | openclaw 1x; clawdbot 10x; gemini 3x |  |
| `docs/development/review-checklist.md` | 105 | 2026-09-19 | quire | **rewrite** | clawdbot 1x |  |
| `docs/discord/DISCORD.md` | 737 | 2026-02-01 | quire | **rewrite** | merge target for DISCORD_SETUP and DISCORD_DEPLOYMENT; 0 rot, 4 routes served live |  |
| `docs/discord/DISCORD_APP_SETUP.md` | 77 | 2026-01-22 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/discord/DISCORD_DEPLOYMENT.md` | 416 | 2026-01-26 | quire | **rewrite** | merge the still-true parts into DISCORD.md |  |
| `docs/discord/DISCORD_INTEGRATION.md` | 515 | 2026-01-29 | otto | **delete** | 11/16 cited routes not served live; DISCORD.md is the survivor — inbound refs to fix: `docs/discord/README.md`, `scripts/test-discord.sh` |  |
| `docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md` | 266 | 2026-01-29 | quire | **rewrite** | Gemini-era summarizer path; CLAUDE.md anchors it, so rewrite not delete — gemini 2x |  |
| `docs/discord/DISCORD_INTEGRATION_PROGRESS.md` | 242 | 2026-01-29 | otto | **delete** | January progress log — inbound refs to fix: `docs/discord/README.md` |  |
| `docs/discord/DISCORD_INTERACTION_STANDARDS.md` | 290 | 2026-01-22 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/discord/DISCORD_SETUP.md` | 218 | 2026-01-22 | quire | **rewrite** | 6/11 cited routes not served live; merge into DISCORD.md — 6/11 cited routes not served live |  |
| `docs/discord/README.md` | 31 | 2026-01-29 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify — broken link(s): `./TEST_DISCORD_BOT.md` |  |
| `docs/discord/REGISTER_DISCORD_COMMANDS.md` | 306 | 2026-01-22 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/discord/TEST_DISCORD_COMMANDS.md` | 368 | 2026-01-22 | otto | **delete** | January manual test script — inbound refs to fix: `docs/discord/README.md` |  |
| `docs/google-chat/README.md` | 27 | 2026-01-24 | otto | **delete** | "Draft"; no google-chat code in backend/ — inbound refs to fix: `docs/README.md` |  |
| `docs/groupme/README.md` | 41 | 2026-09-12 | quire | **rewrite** | 1/1 cited routes not served live |  |
| `docs/instagram/README.md` | 29 | 2026-02-01 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/integrations/COMMONLY_APP_PLATFORM.md` | 78 | 2026-01-29 | quire | **rewrite** | 3/10 cited routes not served live |  |
| `docs/integrations/GROUPME_PLAN.md` | 32 | 2026-01-24 | otto | **delete** | plan superseded by docs/groupme/README.md (shipped) — inbound refs to fix: `docs/README.md`, `docs/integrations/README.md` |  |
| `docs/integrations/INTEGRATION_CONTRACT.md` | 95 | 2026-02-01 | quire | **rewrite** | 1/3 cited routes not served live |  |
| `docs/integrations/MESSENGER_PLAN.md` | 39 | 2026-01-24 | otto | **delete** | never shipped: /api/webhooks/messenger not served live — inbound refs to fix: `docs/README.md`, `docs/integrations/README.md` |  |
| `docs/integrations/PERSONAL_ONEWAY_PLAN.md` | 45 | 2026-01-24 | otto | **delete** | never shipped: 3/3 cited routes not served live — inbound refs to fix: `docs/integrations/README.md` |  |
| `docs/integrations/README.md` | 52 | 2026-04-20 | quire | **rewrite** | clawdbot 1x |  |
| `docs/integrations/WECHAT_READONLY_PLAN.md` | 34 | 2026-01-24 | otto | **delete** | never shipped: /api/webhooks/wechat not served live — inbound refs to fix: `docs/integrations/README.md` |  |
| `docs/integrations/WHATSAPP_READONLY_PLAN.md` | 31 | 2026-01-24 | otto | **delete** | never shipped: /api/webhooks/whatsapp not served live — inbound refs to fix: `docs/README.md`, `docs/integrations/README.md` |  |
| `docs/integrations/decision-card-replies.md` | 70 | 2026-09-06 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/marketplace/AGENT_MANIFEST.md` | 1 | 2026-04-02 | otto | **delete** | 1-line "coming soon" stub; docs-site/marketplace/manifest.mdx is the page — inbound refs to fix: `README.md` |  |
| `docs/plans/2026-08-13-agent-platform-consolidation.md` | 184 | 2026-08-13 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/2026-08-20-persona-v2-phased-rollout.md` | 128 | 2026-08-21 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/2026-08-22-typed-hire-fields-schema.md` | 223 | 2026-09-02 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/2026-08-25-in-pod-browser-view.md` | 147 | 2026-09-01 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/ADMIN_UI_GLOBAL_OAUTH.md` | 271 | 2026-02-06 | otto | **delete** | shipped: header reads "Status: Complete"; git keeps it |  |
| `docs/plans/AGENT_INTEGRATION_TOKENS.md` | 750 | 2026-02-06 | otto | **delete** | abandoned: header reads "Status: Planning" since 2026-02-06, never scheduled; git keeps it |  |
| `docs/plans/IMPLEMENTATION_SUMMARY.md` | 438 | 2026-02-07 | otto | **delete** | Feb status snapshot (Phase 1 complete, Phase 2 "in progress" as of 2026-02-07); git keeps it |  |
| `docs/plans/PUBLIC_LAUNCH_V1.md` | 546 | 2026-02-06 | otto | **delete** | stale by its own header ("Parts of this document are now stale", 2026-02-06); git keeps it — inbound refs to fix: `docs/README.md` — broken link(s): `../../backend/services/externalFeedService.js` |  |
| `docs/plans/SOCIAL_FUN_FEATURES_SPEC.md` | 1256 | 2026-05-02 | otto | **delete** | header reads "partially shipped, framing pre-dates ADR-011"; git keeps it — inbound refs to fix: `docs/README.md` |  |
| `docs/plans/SUMMARIZER_DEPRECATION_RUNBOOK.md` | 83 | 2026-02-06 | otto | **keep** | record: header "Status: In Progress" and summaries.ts / schedulerService.ts still wire summarizerService, so the deprecation is live |  |
| `docs/plans/adr-026-d7-fleet-migration.md` | 203 | 2026-09-12 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/agent-collaboration-surfaces.md` | 643 | 2026-08-22 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/api-token-show-once-2026-09-12.md` | 37 | 2026-09-12 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/cheeky-riding-waffle.md` | 330 | 2026-05-02 | otto | **delete** | shipped: header reads "Status: implemented"; git keeps it |  |
| `docs/plans/connector-as-installable-app.md` | 492 | 2026-09-04 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/connectors-page-signal-diff.md` | 87 | 2026-09-05 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/d8-phase-2-gate-surface.md` | 131 | 2026-09-05 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/decision-card-in-channel.md` | 203 | 2026-09-07 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/idea-register.md` | 117 | 2026-08-04 | otto | **keep** | record, not a current-state claim: living idea register |  |
| `docs/plans/pod-focus-pilot-2026-09-08.md` | 130 | 2026-09-07 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/production-readiness-and-selling-2026-09-11.md` | 150 | 2026-09-19 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/retention-traction-onboarding-2026-07.md` | 205 | 2026-07-02 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/slack-as-installable-connector.md` | 367 | 2026-09-12 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/sprint-2026-05-23-local-dev-and-agent-collab.md` | 91 | 2026-05-23 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/tools-catalogue-room-grants.md` | 265 | 2026-09-19 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/plans/webhook-hardening-2026-09-12.md` | 76 | 2026-09-12 | otto | **keep** | record, not a current-state claim: dated plan |  |
| `docs/runbooks/agent-avatar-resolution-and-recovery.md` | 103 | 2026-07-02 | quire | **rewrite** | deadhost 3x; gemini 1x |  |
| `docs/runbooks/clawdbot-gateway-config-crashloop.md` | 94 | 2026-06-29 | otto | **keep** | record: write-up of the 2026-06-28 incident CLAUDE.md cites; add a first-line "deployment retired (ADR-021)" note — openclaw 13x; clawdbot 9x |  |
| `docs/runbooks/codex-in-gateway-pod.md` | 256 | 2026-06-29 | otto | **keep** | record: ADR-005 links it twice (l.16, l.298) and ADRs are not rewritten; add a first-line "deployment retired (ADR-021)" note — clawdbot 4x; deadhost 2x; gemini 1x; attach 3x |  |
| `docs/runbooks/connector-credentials-setup.md` | 391 | 2026-09-18 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 4 route(s) served live |  |
| `docs/runbooks/cross-tool-operator-handoff.md` | 110 | 2026-09-07 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/runbooks/db-backup-restore.md` | 308 | 2026-07-11 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/runbooks/diagnosing-a-silent-seat.md` | 133 | 2026-08-18 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/runbooks/domain-migration-commonly-me.md` | 97 | 2026-07-02 | otto | **keep** | record, not a current-state claim: records the flip away from the dead hostnames |  |
| `docs/runbooks/error-tracking.md` | 127 | 2026-07-10 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/runbooks/gcp-cost-optimization.md` | 217 | 2026-07-03 | quire | **rewrite** | clawdbot 2x |  |
| `docs/runbooks/hosted-agent-provisioning.md` | 105 | 2026-08-31 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 7 route(s) served live |  |
| `docs/runbooks/litellm-claude-code.md` | 185 | 2026-05-23 | quire | **rewrite** | openclaw 11x |  |
| `docs/runbooks/litellm-guardrails.md` | 115 | 2026-07-01 | quire | **rewrite** | openclaw 2x |  |
| `docs/runbooks/local-ui-render-harness.md` | 307 | 2026-09-19 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 4 route(s) served live |  |
| `docs/runbooks/mention-attention-resolution.md` | 40 | 2026-09-06 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/runbooks/pg-pool-exhaustion.md` | 80 | 2026-05-31 | quire | **rewrite** | 1/5 cited routes not served live |  |
| `docs/runbooks/reading-github-actions-state.md` | 343 | 2026-08-29 | quire | **rewrite** | clawdbot 2x |  |
| `docs/security-patterns.md` | 147 | 2026-05-22 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs/self-hosting/helm-reference.md` | 234 | 2026-04-05 | quire | **rewrite** | clawdbot 2x |  |
| `docs/skills/AWESOME_AGENT_SKILLS.md` | 29 | 2026-02-01 | otto | **delete** | Feb link list; gateway-era. The k8s refs point at the Helm chart's own `configs/AWESOME_AGENT_SKILLS.md` copy, so the delete PR does not touch Helm — inbound refs to fix: `k8s/IMPLEMENTATION_STATUS.md`, `k8s/MIGRATION_SUMMARY.md`, `k8s/helm/commonly/templates/configmaps/backend-config.yaml` |  |
| `docs/skills/SKILLS_CATALOG.md` | 106 | 2026-02-06 | quire | **rewrite** | skills are live (/api/skills mounted); catalog is gateway-era — openclaw 3x |  |
| `docs/slack/README.md` | 39 | 2026-01-29 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 1 route(s) served live |  |
| `docs/task_optimization/UNIFIED_DISCORD_API.md` | 239 | 2026-01-29 | otto | **delete** | completed January task note; folder has no other file |  |
| `docs/telegram/README.md` | 47 | 2026-01-29 | otto | **keep** | 0 rot; verified 0 CLI cmd(s) in 0.1.58 + 1 route(s) served live |  |
| `docs/whatsapp/README.md` | 13 | 2026-01-24 | otto | **delete** | WhatsApp never shipped (see WHATSAPP_READONLY_PLAN) |  |
| `docs/whatsapp/WHATSAPP_API_NOTES.md` | 37 | 2026-01-24 | otto | **delete** | WhatsApp never shipped — inbound refs to fix: `docs/README.md` |  |
| `docs/whatsapp/WHATSAPP_INTEGRATION_PLAN.md` | 81 | 2026-01-29 | otto | **delete** | WhatsApp never shipped — inbound refs to fix: `docs/README.md` |  |
| `docs/x/README.md` | 39 | 2026-02-09 | otto | **keep** | 0 rot; prose only, no CLI/route claim to verify |  |
| `docs-site/docs.json` | 127 | 2026-09-01 | folio | **rewrite** | nav restructure: add connectors/grants, daemon/seats, pi/claude/codex adapters; new pages under docs-site/ belong to this row |  |

## Cited routes not served live

These were probed without auth, using the documented method. Every one of them returned `Cannot <METHOD> <path>`, which the backend only sends when no route matches.

- `ANY /api/:id/health`
- `ANY /api/agents/:id/skills`
- `ANY /api/agents/runtime/config`
- `ANY /api/agents/runtime/contacts`
- `ANY /api/apps/installations/:id/token`
- `ANY /api/auth/me`
- `ANY /api/auth/oauth/github`
- `ANY /api/installables/:id`
- `ANY /api/marketplace/install`
- `ANY /api/marketplace/publish/:id`
- `ANY /api/telemetry/redirects`
- `ANY /api/users/me/contacts`
- `ANY /api/webhooks/groupme/:id`
- `ANY /api/webhooks/messenger/:id`
- `ANY /api/webhooks/slack/:id`
- `ANY /api/webhooks/wechat/:id`
- `ANY /api/webhooks/whatsapp/:id`
- `DELETE /api/integrations/discord/uninstall/:id`
- `DELETE /api/messages/:id/reactions`
- `DELETE /api/pods/:id/members`
- `DELETE /api/v1/registry/agents/moltbot`
- `GET /api/agents-runtime/pods/:id/context`
- `GET /api/agents/runtime/config`
- `GET /api/apps/:id/installations`
- `GET /api/discord/integration/:id`
- `GET /api/discord/stats/:id`
- `GET /api/installables/slack/authorize-url`
- `GET /api/integrations/:id/ledger`
- `GET /api/integrations/:id/summaries`
- `GET /api/integrations/connect/:id/callback`
- `GET /api/integrations/connect/:id/start`
- `GET /api/integrations/discord/binding/:id`
- `GET /api/integrations/discord/install-link/:id`
- `GET /api/marketplace/stars/:id/:id/:id`
- `GET /api/media/:id`
- `GET /api/media/:id/thumb`
- `GET /api/v1/agents/runtime/events`
- `GET /api/v1/agents/runtime/memory`
- `GET /api/v1/agents/runtime/pods/:id/context`
- `GET /api/v1/registry/agents`
- `GET /api/v1/registry/agents/moltbot`
- `GET /api/v1/registry/agents/moltbot/versions`
- `GET /api/webhooks/messenger/:id`
- `PATCH /api/agents/runtime/runs/:id`
- `PATCH /api/apps/:id`
- `PATCH /api/pods/:id/members/:id`
- `PATCH /api/v1/registry/agents/moltbot`
- `POST /api/agents-runtime/pods/:id/messages`
- `POST /api/agents/generate-avatar`
- `POST /api/agents/runtime/render`
- `POST /api/discord/commands/disable`
- `POST /api/discord/commands/enable`
- `POST /api/discord/commands/status`
- `POST /api/discord/commands/summary`
- `POST /api/discord/integration`
- `POST /api/discord/invite`
- `POST /api/discord/test-webhook`
- `POST /api/github/token`
- `POST /api/integrations/:id/summarize`
- `POST /api/integrations/:id/webhook/toggle`
- `POST /api/media`
- `POST /api/media/presigned-put`
- `POST /api/pods/:id/messages`
- `POST /api/registry/admin/agents/claude-code/token`
- `POST /api/registry/agents/:id/instances/:id/reprovision`
- `POST /api/v1/agents/runtime/events/acknowledge`
- `POST /api/v1/agents/runtime/pods/:id/messages`
- `POST /api/v1/pods/:id/memory/:id`
- `POST /api/v1/registry/install`
- `PUT /api/discord/integration/:id`
- `PUT /api/v1/agents/runtime/memory`
