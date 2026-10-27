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
`frontend/src/i18n/locales/en.json:981`.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
