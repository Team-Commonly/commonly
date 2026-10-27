# Docs claim table

One row per factual claim on a customer-facing page, each with one verdict and its evidence. The
rule is in [fleet-efficiency.md §6](../agents/fleet-efficiency.md#6-claims). Evidence is a walk on
prod with a 390 and a 1440 screenshot, or a `file:line` on `main`. It is no older than 14 days. A
claim past 14 days is re-walked in the next release batch, or it comes out. The first-touch pages
(quickstart, bring your own agent, connectors, self-host, pricing) are re-walked every week.

## Verdicts

- **WALKED**: someone who did not write the claim did it on commonly.me. The evidence is a 390 and a
  1440 screenshot.
- **TRUE**: code on `main` does what the claim says. The evidence is a `file:line` on `main`, not
  another doc.
- **STALE**: the feature or fact is gone. The same PR removes the claim.
- **FALSE**: the claim is wrong. The same PR fixes it or removes it.
- **CUT**: the claim was not walked in time. The same PR removes it, and it can come back with
  evidence.

Screenshots for this table go in `docs/audits/claim-table/<section>/`. No screenshot may show a
token, a command with a token in it, or an email address.

Each page has its own section, and each page's PR edits only its own section.

## README

Owner: TASK-010. Source: `README.md`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Quickstart and introduction

Owner: TASK-011. Source: `docs-site/quickstart.mdx` and `docs-site/introduction.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| quickstart | Create an account at commonly.me/v2/register | TRUE | `frontend/src/v2/V2App.tsx:215` (`register` route) | 2026-10-26 |
| quickstart | Create a pod; it opens with a "Your pod is ready" card | TRUE (copy); walk pending | `frontend/src/i18n/locales/en.json:617` (`newPod.title`), rendered by `V2ThreadStarter.tsx`. GTM walk with 390 and 1440 shots still owed | 2026-10-26 |
| quickstart | On that card, "Run it here" starts a hosted agent | TRUE (copy); walk pending | `en.json:619` (`runHere`); starter states "Adding agent…", "Starting agent…", "Agent running" at `en.json:622-624`. Timing (about 8 s) is not on the page and needs a walk | 2026-10-26 |
| quickstart | Type `@` in the pod's message box to pick the agent | TRUE (copy); walk pending | `en.json:612` ("Use @ to mention an agent or teammate") | 2026-10-26 |
| quickstart | Commonly runs a hosted agent on DeepSeek V4 Flash | TRUE | `backend/services/nativeRuntimeService.ts:101` (`DEFAULT_MODEL`), `:224` (display name). Overridable by `LITELLM_CHAT_MODEL`, so re-check on prod | 2026-10-26 |
| quickstart | The Run it here setup shows the free plan's agent and daily turn limits | TRUE | `frontend/src/v2/components/V2AgentBYO.tsx:1136-1139` renders `hosting.caps.turnsPerDay`; caps from `backend/services/hostedRuntimeService.ts:55-60`. No numbers are stated on the page | 2026-10-26 |
| quickstart | "About a minute" (frontmatter description) | CUT | No walk of the full sign-up-to-answer time. Removed from the description | 2026-10-26 |
| quickstart | Links: `/bring-your-own/`, `/bring-your-own/claude-code`, `/codex`, `/work-in-your-repo`, `/concepts/pods` | TRUE | Targets exist: `docs-site/bring-your-own/*.mdx`, `docs-site/concepts/pods.mdx` | 2026-10-26 |
| introduction | Commonly can host an agent for you ("Run it here") | TRUE | `en.json:1621` (`hosted`: "Run it here") | 2026-10-26 |
| introduction | Agents run on your own machine and connect with a runtime token | TRUE | `backend/middleware/agentRuntimeAuth.ts:52` (`cm_agent_` token); `cli/src/index.js:62` (`commonly agent attach`) | 2026-10-26 |
| introduction | A pod holds conversation, files, tasks and context | TRUE | Conversation: `backend/models/Message.ts:43` (`podId`). Files: `backend/models/PodAsset.ts:40` (`podId`). Tasks: `backend/routes/tasksApi.ts:226-253` (`GET /:podId` filters `Task.find` by `podId`; mounted at `backend/server.ts:257`). Context: `backend/routes/contextApi.ts:80-91` (`/context/:podId`) | 2026-10-26 |
| introduction | Each agent keeps its own identity and memory | TRUE | Agent memory routes: `backend/routes/agentMemoryView.ts`, `backend/routes/agentProfile.ts` | 2026-10-26 |
| introduction | Request a seat via Agents → Bring your own agent → On my computer, then pick the computer and seat | TRUE (copy); walk pending | `en.json:70` ("Agents"), `:1510` ("Bring your own agent"), `:1630` ("On my computer"). The click path needs a walk | 2026-10-26 |
| introduction | The local daemon supervises requested seats and owns the machine credential | TRUE | `cli/src/lib/daemon-supervisor.js` (machine heartbeat, D5); `cli/src/index.js:46` (daemon lifecycle) | 2026-10-26 |
| introduction | The manual `commonly agent attach` flow remains available and does not request a seat for the daemon | TRUE (command); the "does not request" half is not yet cited | `cli/src/index.js:62` shows the command. Needs a `file:line` for the no-seat-request behaviour | 2026-10-26 |
| introduction | Card links resolve (concepts, agents, deployment, runtime-protocol, openapi) | TRUE | Targets exist, including `docs/api/openapi.yaml` | 2026-10-26 |
| introduction | The pod can mix Claude Code, Codex, a hosted agent and your own program | TRUE | `frontend/src/v2/components/V2RuntimeControls.tsx:18` (runtime labels) | 2026-10-26 |

## Bring your own agent

Owner: TASK-012. Source: `docs-site/bring-your-own/index.mdx`, `claude-code.mdx`, `codex.mdx` and
`work-in-your-repo.mdx`, and the in-app setup at `commonly.me/v2/agents/byo`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Connectors and grants

Owner: TASK-014. Source: `docs-site/concepts/connectors.mdx` and `docs-site/concepts/grants.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Self-host

Owner: TASK-013. Source: `docs-site/deployment/index.mdx`, `docker.mdx`, `kubernetes.mdx` and
`environment-variables.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Pricing

Owner: TASK-015. The docs site has no pricing page. `commonly.me/pricing` redirects to the landing
page's pricing section (`frontend/nginx.conf:36`), which renders at
`frontend/src/v2/landing/V2LandingPage.tsx:827` with its copy under `landing.pricing` in
`frontend/src/i18n/locales/en.json:981`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|

## Other customer surfaces

Owner: TASK-009. Source: the `docs-site/` pages outside the sections above, the in-app Connect,
Settings, onboarding and empty-state copy, `frontend/public/llms.txt` (its Linux line is TASK-016's),
the FAQ, and `CONTRIBUTING.md`. The section is complete when every surface in that list has its rows.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| In-app Plan (`billing.proNote`) | "…and hosted agent seats when they land." | FALSE | Hosted agents have shipped. `backend/services/hostedRuntimeService.ts:36` gives a free account one agent (`DEFAULT_AGENTS_PER_USER = 1`). The key has no call site, so the sentence is removed with it. | 2026-10-26 |
| In-app Plan (`billing.freeNote`) | "Unlimited agents you bring, and 30 days of message history. …" | CUT | No call site in `frontend/src` or `backend`. The only other match is a fixture label at `frontend/src/i18n/__tests__/zhNumberUnitSpacing.test.ts:254`, which reads no catalog value. The key is removed. | 2026-10-26 |
| Landing, open-source list (`landing.openSource.items.federation`) | "Federation on the roadmap. Agents on different instances will interact — ActivityPub for agents." | CUT | `git grep -i activitypub` finds nothing under `backend`, `frontend/src` or `docs-site`. The federation code that exists is cross-pod queries (`backend/services/federationService.ts:1-5`). The bullet is removed; it can return with a shipped track or a walk. | 2026-10-26 |
| CONTRIBUTING.md | "pick up an open issue labeled `good first issue` on GitHub" (the label-query link on main before this PR) | FALSE | `gh issue list -R Team-Commonly/commonly --label "good first issue" --state open` returned 0 on 2026-10-26, so the link opened an empty list. The earlier task-board link, `app-dev.commonly.me/pods/team`, was already dead (`CLAUDE.md`, Quick Start). This PR replaces the link with the open-issues list, which had 138 open issues on 2026-10-27. | 2026-10-27 |
| CONTRIBUTING.md | "you can install it into the public Commonly instance" (OpenClaw) | TRUE | The provider route exists: `backend/routes/providers/moltbot.ts:4`. This row checks the code path only, not a contributor install on commonly.me. | 2026-10-26 |
| CONTRIBUTING.md | "pick up an open issue on GitHub" (the open-issues link) | TRUE | `gh issue list -R Team-Commonly/commonly --state open` returned 138 on 2026-10-27. `--label "good first issue"` returned 0, so the old label link was empty. | 2026-10-27 |
| CONTRIBUTING.md | "you can install Claude Code or Codex into the public Commonly instance" | TRUE (code path only) | `cli/src/commands/agent.js:3671` (`.command('attach <adapter>')`); `cli/src/commands/agent.js:173` (`BOOTSTRAP_ADAPTER_DETECT_ORDER = ['claude', 'codex', 'pi']`). Not a contributor install on commonly.me. | 2026-10-27 |
