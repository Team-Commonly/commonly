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
| README | Commonly AI is open-source (L12) | TRUE | LICENSE:2 (Apache License). The rest of L7 is positioning and has no row; GTM owns the wording. | 2026-10-26 |
| README | Trust: only the access you grant (L48) | TRUE | Takes the verdict of the grant rows below. | 2026-10-26 |
| README | Connect a tool once, then choose which pods and agents may use it (L48) | TRUE | backend/services/roomGrantService.ts:412 (`tool_not_allowed`: a grant's `tools` list gates every call); backend/routes/grants.ts (grant issue and revoke routes). ADR-033 gives the design. | 2026-10-26 |
| README | An agent with a read-only grant sees only that tool's read actions (L48) | TRUE | backend/services/roomGrantService.ts:418 (`write_mode_not_allowed`: a grant rank below the tool's `requiredWriteMode` is refused); backend/services/toolBrokerService.ts:1247–1248 (`write-with-confirm` parks every write). | 2026-10-26 |
| README | Connect your own Claude Code from your Mac (L34) | TRUE | cli/src/lib/adapters/claude.js (ships in the CLI) | 2026-10-26 |
| README | Or start one in the pod in one click (L34) | TRUE | frontend/src/i18n/locales/en.json:621 ("Run it here"); frontend/src/v2/components/V2AgentBYO.tsx:137 (`?mode=hosted` from the "Run it here" button) | 2026-10-26 |
| README | Agents claim work on the pod's board and post what they tried (L36) | TRUE | backend/routes/tasksApi.ts:594 (`POST /:podId/:taskId/claim`); backend/routes/tasksApi.ts:787 (`POST /:podId/:taskId/updates`) | 2026-10-26 |
| README | Activity shows what needs you across every pod (L38) | TRUE | frontend/src/i18n/locales/en.json:161 ("what needs you, then what moved"), :176 ("All pods" filter), :814 ("Every open question in one place") | 2026-10-25 |
| README | On commonly.me, with nothing to install (L60) | TRUE | Takes the verdict of the hosted-agent row above (en.json:621, V2AgentBYO.tsx:137). | 2026-10-26 |
| README | Sign up with GitHub, Google or email (L62) | TRUE | backend/controllers/authController.ts:615–627 (`registrationOpen`); backend/routes/auth.ts:256 (`/registration-policy`); live `https://api.commonly.me/api/auth/registration-policy` on 10-25 returned `inviteOnly:false, registrationOpen:true`. Invite-only is the production default when `REGISTRATION_INVITE_ONLY` is unset (authController.ts:36–40), so this depends on that env var being off. Providers: frontend/src/i18n/locales/en.json:116–117, :380 (Google, GitHub). | 2026-10-25 |
| README | Install the CLI with `npm i -g @commonlyai/cli@latest` (L71) | TRUE | cli/package.json:2 (name), :9 (bin `commonly`) | 2026-10-25 |
| README | `commonly agent run <name> --adapter claude` (L74) | TRUE | cli/src/commands/agent.js:295 (`agent run --adapter`), :361 | 2026-10-25 |
| README | Bring your own → Use my own agent → Get my connect command (L68) | TRUE | frontend/src/i18n/locales/en.json:1620 ("Use my own agent"), :1466 ("Get my connect command") | 2026-10-25 |
| README | The connect page gives four lines with your token filled in (L68–75) | TRUE | frontend/src/v2/components/V2AgentBYO.tsx:981 (install, two exports, `commonly agent run`) | 2026-10-25 |
| README | The page shows **is listening** once running (L77) | TRUE | frontend/src/i18n/locales/en.json:1637 ("{{name}} is listening.") | 2026-10-25 |
| README | Claude Code answers @mentions on macOS (L79) | TRUE | cli/src/lib/adapters/claude.js:760 (workspace trust refused under bwrap: "run on macOS only for now"). Linux support for invite-only pods is in review (#2820) and will change this row when it ships | 2026-10-25 |
| README | On Linux and Windows, the page connects Claude Code over MCP (L79) | TRUE | frontend/src/v2/components/V2AgentBYO.tsx:958 (`claude mcp add … npx -y @commonlyai/mcp`), :965 (Windows `cmd /c commonly-mcp`) | 2026-10-25 |
| README | Codex answers @mentions on macOS (L80, macOS half) | TRUE | cli/src/lib/adapters/codex.js:487 (Codex's permission-profile boundary runs on macOS). The adapter has no platform gate. The mention path itself is not walked; GTM's walk can still cut it. | 2026-10-26 |
| README | Codex answers @mentions on Linux (L80, Linux half) | CUT | frontend/src/v2/components/V2AgentBYO.tsx:103–105 offers Codex on Linux, and nobody has walked it. The line reads "Linux not yet tested". | 2026-10-26 |
| README | OpenCode guide "(walked on macOS)" (was L80; L81 has no parenthetical) | CUT | Nothing shows the walk did not happen, so this is CUT rather than FALSE. The parenthetical is removed in this PR (README.md:81). | 2026-10-27 |
| README | Run it on one machine with Docker and Compose v2 (L87) | TRUE | install.sh:10–15 (checks `docker` and `docker compose version`) | 2026-10-25 |
| README | `./install.sh`, then open http://localhost:3000 (L92–95) | TRUE | install.sh:62 (prints `http://localhost:3000`) | 2026-10-25 |
| README | This one-command install (`docker-compose.local.yml`) runs MongoDB and PostgreSQL locally, so chat, the tool broker, decisions and reactions all work (L97) | TRUE | README.md:97; install.sh:52–57; docker-compose.local.yml:24–79 | 2026-10-27 |
| README | Quickstart, Connectors and Daemon docs links (L101) | TRUE | `https://docs.commonly.me/quickstart`, `/concepts/connectors`, `/agents/daemon` return 200 on 10-26. A 200 counts on docs.commonly.me, where a dead page returns 404. | 2026-10-26 |
| README | MCP, CLI, agent protocol, architecture and design-record links (L101) | TRUE | docs/MCP_INTEGRATION.md, docs/cli/README.md, docs/agents/AGENT_RUNTIME.md, docs/architecture/ARCHITECTURE.md, docs/adr/ are present in the tree | 2026-10-26 |
| README | Discord invite (L105) | TRUE | `https://discord.com/api/v10/invites/NsS3fzsJDw` returned an invite object (code, inviter) on 10-26. A 200 alone does not count for Discord, so this was checked against the invite object. | 2026-10-26 |
| README | Report a vulnerability privately (L107) | TRUE | SECURITY.md:9–13 (email security@commonly.me; "do not report … through public GitHub issues") | 2026-10-25 |
| README | `good first issue` label (L111) | TRUE | `gh api repos/Team-Commonly/commonly/labels/good%20first%20issue` returns the label name (10-26) | 2026-10-26 |
| README | Apache-2.0 licence (L113) | TRUE | LICENSE; cli/package.json:4 | 2026-10-25 |

## Quickstart and introduction

Owner: TASK-011. Source: `docs-site/quickstart.mdx` and `docs-site/introduction.mdx`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| quickstart | Create an account at commonly.me/v2/register | TRUE | `frontend/src/v2/V2App.tsx:215` (`register` route) | 2026-10-26 |
| quickstart | Create a pod; it opens with a "Your pod is ready" card | TRUE (copy); walk pending | `frontend/src/i18n/locales/en.json:619` (`newPod.title`), rendered by `V2ThreadStarter.tsx`. GTM walk with 390 and 1440 shots still owed | 2026-10-26 |
| quickstart | On that card, "Run it here" starts a hosted agent | TRUE (copy); walk pending | `en.json:621` (`runHere`); starter states "Adding agent…", "Starting agent…", "Agent running" at `en.json:624-626`. Timing (about 8 s) is not on the page and needs a walk | 2026-10-26 |
| quickstart | Type `@` in the pod's message box to pick the agent | TRUE (copy); walk pending | `en.json:614` ("Use @ to mention an agent or teammate") | 2026-10-26 |
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
| introduction | Each agent is a named member with an owner | TRUE | `backend/models/AgentRegistry.ts:261` (`installedBy`, required, on every installation) | 2026-10-27 |
| introduction | A teammate joins by link and sees the conversation so far | TRUE; walked | Prod walk 10-27: a second person redeemed the pod's invite link and saw earlier messages. The invite card says so: `en.json:2640` ("They'll see everything in this pod, including earlier messages") | 2026-10-27 |
| introduction | Connect your own Claude Code, or start one in the pod in one click | TRUE; walked | Same claims as the quickstart rows above ("Run it here") and `docs-site/bring-your-own/claude-code.mdx`, re-walked 10-26 (TASK-011) | 2026-10-27 |
| introduction | Every agent sits on the pod's one roster | TRUE; walked | The roster is the pod's agent list ("agents in {{pod}}", `en.json:1221`, rendered at `frontend/src/v2/components/V2Inspector.tsx:208`), fed by `GET /api/registry/pods/:podId/agents` (`backend/routes/registry/pod-agents.ts:179`, `AgentInstallation.getInstalledAgents(podId)`: every installed agent in the pod, whatever its runtime). Prod walk 10-27: a BYO Claude Code agent and a hosted agent listed together in one pod. Not Your Team, which lists your agents across pods | 2026-10-27 |
| introduction | Agents file tasks | TRUE; walked | `backend/routes/tasksApi.ts:245` (`POST /:podId`, `dualAuth`; `:255` takes `req.agentUser` as the creator). Prod walk 10-27: an agent filed TASK-001 on a person's ask | 2026-10-27 |
| introduction | Agents post what they tried | TRUE | `backend/routes/tasksApi.ts:787` (`POST /:podId/:taskId/updates`, `dualAuth`; `:790` takes `req.agentUser`): an agent appends update notes to a task | 2026-10-27 |
| introduction | A connected agent claims a task and the card moves to In Progress under its name | TRUE | `backend/routes/tasksApi.ts:594` (`POST /:podId/:taskId/claim` sets `status: 'claimed'`, `claimedBy`); `frontend/src/v2/components/V2PodBoard.tsx:105-109` renders `claimed` in the `board.col.inProgress` column (`en.json:1383`, "In Progress"). A hosted agent has no claim tool yet, so the page says *connected* | 2026-10-27 |
| introduction | The agent asks you on a card, and Activity shows what needs you across every pod | TRUE | `frontend/src/v2/components/V2ActivityPage.tsx:49` (`decision` kind), `:403` (`/api/activity/decision-queue`); `en.json:206-210` ("Needs you") | 2026-10-27 |

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
| index | Needs Git, Docker Engine with the Compose v2 plugin, OpenSSL, and free ports 3000 and 5000 | TRUE | Compose v2 check `install.sh:15-17`; openssl `install.sh:31-33`, `:43-45`; published ports `docker-compose.local.yml:71`, `:126`. The installer does not check the ports, so "free" is advice | 2026-10-27 |
| index | Check Docker with `docker compose version` | TRUE | Same command is the Compose v2 check at `install.sh:15` | 2026-10-27 |
| index | "Run the same three steps shown on the Commonly home page" | TRUE | `frontend/src/v2/landing/V2LandingPage.tsx:36` (`SELF_HOST_COMMAND`: the same clone, `cd`, `./install.sh`, joined with `&&`) | 2026-10-27 |
| index | The three commands: `git clone https://github.com/Team-Commonly/commonly.git`, `cd commonly`, `./install.sh` | TRUE | `V2LandingPage.tsx:36`; `install.sh` exists at repo root | 2026-10-27 |
| index | Open http://localhost:3000 after install | TRUE | `install.sh:62` prints `App: http://localhost:3000`; frontend port `docker-compose.local.yml:126` | 2026-10-27 |
| index | The installer builds and starts the frontend, backend, MongoDB and PostgreSQL | TRUE | `install.sh:57` (`up -d --build`); services `docker-compose.local.yml:24` (postgres), `:43` (mongo), `:58` (backend), `:114` (frontend) | 2026-10-27 |
| index | With no `.env`, the installer creates an ignored one with a generated `JWT_SECRET` and `PG_PASSWORD` | TRUE | `install.sh:21-37` (JWT), `:42-48` (PG_PASSWORD); `.env` is ignored at `.gitignore:12` | 2026-10-27 |
| index | Changing the secret signs everyone out | TRUE | Tokens verify against `JWT_SECRET` at `backend/middleware/auth.ts:113`, so a new secret fails existing tokens. Not walked | 2026-10-27 |
| index | Compose setup is for one machine; no TLS, reverse proxy or public-domain configuration | TRUE | `docker-compose.local.yml` has four services and no proxy or TLS service (`:24`, `:43`, `:58`, `:114`); header states "Local, single-machine setup" (`:2`) | 2026-10-27 |
| index | Keep its ports off the public internet | TRUE | Backend and frontend publish `5000` and `3000` (`docker-compose.local.yml:71`, `:126`); the database services publish none | 2026-10-27 |
| index | The frontend calls `http://localhost:5000` (build-time) | TRUE | `docker-compose.local.yml:120` (`REACT_APP_API_URL=http://localhost:5000`) | 2026-10-27 |
| index | A browser on another device would call its own localhost, so open the app on the machine that runs it | TRUE | Follows from the build-time URL at `docker-compose.local.yml:120`. Not walked from a second device | 2026-10-27 |
| index | Health checks, updates and data retention are in the local deployment guide | TRUE | Link target `docs/deployment/SELF_HOSTED.md` exists | 2026-10-27 |
| index | Public deployments: Kubernetes guide and Helm values reference | TRUE | Link targets `docs/deployment/KUBERNETES.md` and `docs/self-hosting/helm-reference.md` exist; `k8s/helm/commonly/values.yaml` exists | 2026-10-27 |
| docker | The local profile builds frontend, backend, MongoDB and PostgreSQL on one machine, with no TLS, reverse proxy or public-domain configuration | TRUE | `docker-compose.local.yml:24`, `:43`, `:58`, `:114`; no TLS or proxy service | 2026-10-27 |
| docker | `curl --fail --silent http://localhost:5000/api/health` checks the API | TRUE | `backend/server.ts:283` mounts `/api/health`; `backend/routes/health.ts:21` returns `status: 'healthy'`; backend port `docker-compose.local.yml:71` | 2026-10-27 |
| docker | `docker compose --env-file .env -f docker-compose.local.yml ps` and `down` | TRUE | Compose file exists at repo root; `install.sh:68-69` prints the same `--env-file … -f docker-compose.local.yml` form for `logs` and `down`. `ps` is not printed by the installer, but is a valid Compose v2 subcommand | 2026-10-27 |
| docker | `down` keeps the MongoDB and PostgreSQL volumes; `-v` removes both | TRUE | Named volumes `mongo-data` and `postgres-data` at `docker-compose.local.yml:134-136`; `-v` removes named volumes per Compose semantics. Not run | 2026-10-27 |
| docker | Logs, updates and optional settings are in the repository's local deployment guide | TRUE | Link target `docs/deployment/SELF_HOSTED.md` exists | 2026-10-27 |
| environment-variables | With no `.env`, the installer creates one with a generated `JWT_SECRET` and `PG_PASSWORD` | TRUE | `install.sh:21-37`, `:42-48` | 2026-10-27 |
| environment-variables | If `.env` exists without `PG_PASSWORD`, the installer adds one | TRUE | `install.sh:42-48` (appends `PG_PASSWORD` under `umask 077`) | 2026-10-27 |
| environment-variables | If `.env` exists without a non-default `JWT_SECRET`, `./install.sh` stops and asks you to set one | TRUE | `install.sh:22-28` (exits 1 on a missing or `change-me-in-production-…` value) | 2026-10-27 |
| environment-variables | Keep the value private and stable so existing sessions continue | TRUE | Tokens verify against `JWT_SECRET` at `backend/middleware/auth.ts:113` | 2026-10-27 |
| environment-variables | The local profile forwards only the variables listed in `docker-compose.local.yml` | TRUE | Backend `environment:` list `docker-compose.local.yml:72-112`; no `env_file:` in the file (grep count 0). `--env-file` only supplies `${…}` interpolation (`install.sh:57`) | 2026-10-27 |
| environment-variables | Putting a variable in `.env` does not make the local profile forward it | TRUE | Same evidence as the row above: only listed variables reach the backend container | 2026-10-27 |
| environment-variables | `.env.example` covers broader development and deployment settings | TRUE | `.env.example:46` (`JWT_SECRET`) and the wider file | 2026-10-27 |
| environment-variables | Connector setup follows its guide and the self-hosting guide | TRUE | Link target `docs/deployment/SELF_HOSTED.md` exists | 2026-10-27 |
| kubernetes | The three-step install is a local Compose setup and does not supply TLS, ingress, database, secrets or a backup plan | TRUE | `docker-compose.local.yml` has no TLS, ingress or backup service; the database is a local container (`:24`, `:43`); secrets come from `.env` | 2026-10-27 |
| kubernetes | Repository deployment guide and Helm values reference are the Kubernetes path | TRUE | `docs/deployment/KUBERNETES.md` and `docs/self-hosting/helm-reference.md` exist; `k8s/helm/commonly/values.yaml` exists | 2026-10-27 |
| kubernetes | Choose image, database, secrets, ingress and backup settings before running Helm | TRUE | Advice; the chart exposes these as values in `k8s/helm/commonly/values.yaml`. Not walked | 2026-10-27 |

## Pricing

Owner: TASK-015. The docs site has no pricing page. `commonly.me/pricing` redirects to the landing
page's pricing section (`frontend/nginx.conf:36`), which renders at
`frontend/src/v2/landing/V2LandingPage.tsx:827` with its copy under `landing.pricing` in
`frontend/src/i18n/locales/en.json:978`.

Evidence below is `main` at `75d80918e`. Rows marked "Removed here" or "Now" are fixed in the PR that
adds them. Rows that name another PR were already fixed on main.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| Landing pricing | "10 hosted agent seats" | FALSE | `backend/services/hostedRuntimeService.ts:36` `DEFAULT_AGENTS_PER_USER = 1`, the same on every plan (`:58`). Removed here. | 2026-10-26 |
| Landing pricing | "coming soon, included when it lands" (hosted) | FALSE | Hosted agents run now; per-plan caps are wired in `backend/services/hostedRuntimeService.ts:58-61`. Removed here. | 2026-10-26 |
| Landing pricing | "SSO/SAML" | FALSE | No code: `git grep -i saml origin/main -- backend frontend/src` matches only the copy (`en.json:1021`, `zh-CN.json:1020`). Main already reads "SSO/SAML is planned" (#2856, `bafad4060`). This PR keeps that wording, and the guard allows that phrase and no other SSO/SAML copy. | 2026-10-26 |
| Landing pricing | "federation across instances" | FALSE | Federation is cross-pod inside one instance: `backend/server.ts:271`, `backend/services/federationService.ts:1-5`. `federationProtocol` is only declared in the schema (`backend/models/Installable.ts:242`, `:482`). Removed on main by #2856 (`bafad4060`). | 2026-10-26 |
| Landing pricing | "30 days of message history" (as a flat promise) | FALSE | `backend/services/pgRetentionService.ts:47` (30-day default), `:51` (1-day floor), `:267-296` (steps down under disk pressure). Now "Up to 30 days". | 2026-10-26 |
| Landing pricing | "Pro adds hosted agents" | FALSE | Cloud free gets hosted agents too: the agent cap ignores plan (`backend/services/hostedRuntimeService.ts:58`); the plan only changes turns (`:60-61`). Now "a higher hosted-agent turn cap". | 2026-10-26 |
| Landing pricing | "Pro adds unlimited history" (unscoped) | FALSE | Only pods the buyer created: `backend/services/pgRetentionService.ts:125-150` (the pod's creator governs), `:166` (Pro flag read on the creator). Now "in pods you create". | 2026-10-26 |
| Landing pricing | "Up to 30 days of message history" (Cloud free) | TRUE | `backend/services/pgRetentionService.ts:47,51,267-296`. A ceiling: disk pressure can shorten it. | 2026-10-26 |
| Landing pricing | "Unlimited history in pods you create" (Pro) | TRUE | `backend/services/pgRetentionService.ts:125-150,166`. | 2026-10-26 |
| Landing pricing | "Hosted agents: 200 turns a day per agent, against 30 on Cloud free" | TRUE | Code defaults `backend/services/hostedRuntimeService.ts:38-39`, plan switch `:60-61`, per agent per UTC day `:11-13`. Live env not read: no `HOSTED_TURNS*` override in repo k8s or docs. | 2026-10-26 |
| Landing pricing | "Community listing" (Pro) | TRUE | `backend/routes/pods.ts:768-770`: a non-admin pod creator without `entitlements.pro` gets 402 `pro_required`. | 2026-10-26 |

## Other customer surfaces

Owner: TASK-009. Source: the `docs-site/` pages outside the sections above, the in-app Connect,
Settings, onboarding and empty-state copy, `frontend/public/llms.txt` (its Linux line is TASK-016's),
the FAQ, and `CONTRIBUTING.md`. The section is complete when every surface in that list has its rows.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| In-app Plan (`billing.proNote`) | "…and hosted agent seats when they land." | FALSE | Hosted agents have shipped. `backend/services/hostedRuntimeService.ts:36` gives a free account one agent (`DEFAULT_AGENTS_PER_USER = 1`). The key has no call site, so the sentence is removed with it. | 2026-10-26 |
| In-app Plan (`billing.freeNote`) | "Unlimited agents you bring, and 30 days of message history. …" | CUT | No call site in `frontend/src` or `backend`. The only other match is a fixture label at `frontend/src/i18n/__tests__/zhNumberUnitSpacing.test.ts:256`, which reads no catalog value. The key is removed. | 2026-10-26 |
| Landing, open-source list (`landing.openSource.items.federation`) | "Federation on the roadmap. Agents on different instances will interact — ActivityPub for agents." | CUT | `git grep -i activitypub` finds nothing under `backend`, `frontend/src` or `docs-site`. The federation code that exists is cross-pod queries (`backend/services/federationService.ts:1-5`). The bullet is removed; it can return with a shipped track or a walk. | 2026-10-26 |
| Landing hero, Your team feature, proof line (`landing.hero.lede`, `landing.features.team.text`, `landing.proof.sub`) | "its own workstation" (en), 工位 (zh-CN) | FALSE | No code backs a per-agent workstation: `git grep -i workstation` over `backend`, `cli` and `frontend/src` (outside locales) finds no code, only an operator-workstation sentence in `frontend/src/content/guides.json`. Removed from all three strings in en and zh-CN. | 2026-10-27 |
| Landing hero, Your team feature, proof line (same keys) | "memory that stays with it" (was "its own memory") | TRUE | Memory is keyed by the agent's identity, not its install or runtime: unique index on `{ agentName, instanceId }` at `backend/models/AgentMemory.ts:326`; the agent reads it as itself at `backend/routes/agentsRuntime.ts:2781-2785` and writes it at `:2822` (ADR-003). Code path only, not walked. | 2026-10-27 |
| Landing hero (`landing.hero.lede`) | "no per-agent fees" | TRUE | The only charge is one Pro subscription at quantity 1, with no agent count: `backend/routes/billing.ts:91` (`line_items: [{ price: priceId, quantity: 1 }]`). Same promise as pricing's "Never per agent" (`en.json:981`, `:1023`), checked against the code by lumen on #2805. | 2026-10-27 |
| CONTRIBUTING.md | "pick up an open issue labeled `good first issue` on GitHub" (the label-query link on main before this PR) | FALSE | `gh issue list -R Team-Commonly/commonly --label "good first issue" --state open` returned 0 on 2026-10-26, so the link opened an empty list. The earlier task-board link, `app-dev.commonly.me/pods/team`, was already dead (`CLAUDE.md`, Quick Start). This PR replaces the link with the open-issues list, which had 138 open issues on 2026-10-27. | 2026-10-27 |
| CONTRIBUTING.md | "you can install it into the public Commonly instance" (OpenClaw) | TRUE | The provider route exists: `backend/routes/providers/moltbot.ts:4`. This row checks the code path only, not a contributor install on commonly.me. | 2026-10-26 |
| CONTRIBUTING.md | "pick up an open issue on GitHub" (the open-issues link) | TRUE | `gh issue list -R Team-Commonly/commonly --state open` returned 138 on 2026-10-27. `--label "good first issue"` returned 0, so the old label link was empty. | 2026-10-27 |
| CONTRIBUTING.md | "you can install Claude Code or Codex into the public Commonly instance" | TRUE (code path only) | `cli/src/commands/agent.js:3671` (`.command('attach <adapter>')`); `cli/src/commands/agent.js:173` (`BOOTSTRAP_ADAPTER_DETECT_ORDER = ['claude', 'codex', 'pi']`). Not a contributor install on commonly.me. | 2026-10-27 |
