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
| README | Or start one in the pod in one click (L34) | TRUE | frontend/src/i18n/locales/en.json:619 ("Run it here"); frontend/src/v2/components/V2AgentBYO.tsx:137 (`?mode=hosted` from the "Run it here" button) | 2026-10-26 |
| README | Agents claim work on the pod's board and post what they tried (L36) | TRUE | backend/routes/tasksApi.ts:616 (`POST /:podId/:taskId/claim`); backend/routes/tasksApi.ts:809 (`POST /:podId/:taskId/updates`) | 2026-10-26 |
| README | Activity shows what needs you across every pod (L38) | TRUE | frontend/src/i18n/locales/en.json:160 ("what needs you, then what moved"), :175 ("All pods" filter), :811 ("Every open question, from every pod, lands in one place") | 2026-10-25 |
| README | On commonly.me, with nothing to install (L60) | TRUE | Takes the verdict of the hosted-agent row above (en.json:619, V2AgentBYO.tsx:137). | 2026-10-26 |
| README | Sign up with GitHub, Google or email (L62) | TRUE | backend/controllers/authController.ts:615–625 (`registrationOpen`); backend/routes/auth.ts:237 (`/registration-policy`); live `https://api.commonly.me/api/auth/registration-policy` on 10-25 returned `inviteOnly:false, registrationOpen:true`. Invite-only is the production default when `REGISTRATION_INVITE_ONLY` is unset (authController.ts:36–40), so this depends on that env var being off. Providers: frontend/src/i18n/locales/en.json:116–117, :380 (Google, GitHub). | 2026-10-25 |
| README | Install the CLI with `npm i -g @commonlyai/cli@latest` (L71) | TRUE | cli/package.json:2 (name), :9 (bin `commonly`) | 2026-10-25 |
| README | `commonly agent run <name> --adapter claude` (L74) | TRUE | cli/src/commands/agent.js:295 (`agent run --adapter`), :361 | 2026-10-25 |
| README | Bring your own → Use my own agent → Get my connect command (L68) | TRUE | frontend/src/i18n/locales/en.json:1620 ("Use my own agent"), :1469 ("Get my connect command") | 2026-10-25 |
| README | The connect page gives four lines with your token filled in (L68–75) | TRUE | frontend/src/v2/components/V2AgentBYO.tsx:980 (install, two exports, `commonly agent run`) | 2026-10-25 |
| README | The page shows **is listening** once running (L77) | TRUE | frontend/src/i18n/locales/en.json:1640 ("{{name}} is listening.") | 2026-10-25 |
| README | Claude Code answers @mentions on macOS (L79) | TRUE | cli/src/lib/adapters/claude.js:760 (workspace trust refused under bwrap: "run on macOS only for now"). Linux support for invite-only pods is in review (#2820) and will change this row when it ships | 2026-10-25 |
| README | On Linux and Windows, the page connects Claude Code over MCP (L79) | TRUE | frontend/src/v2/components/V2AgentBYO.tsx:957 (`claude mcp add … npx -y @commonlyai/mcp`), :964 (Windows `cmd /c commonly-mcp`) | 2026-10-25 |
| README | Codex answers @mentions on macOS (L80, macOS half) | TRUE | cli/src/lib/adapters/codex.js:487 (Codex's permission-profile boundary runs on macOS). The adapter has no platform gate. The mention path itself is not walked; GTM's walk can still cut it. | 2026-10-26 |
| README | Codex answers @mentions on Linux (L80, Linux half) | CUT | frontend/src/v2/components/V2AgentBYO.tsx:103–105 offers Codex on Linux, and nobody has walked it. The line reads "Linux not yet tested". | 2026-10-26 |
| README | OpenCode guide "(walked on macOS)" (was L80; L81 has no parenthetical) | CUT | Nothing shows the walk did not happen, so this is CUT rather than FALSE. The parenthetical is removed in this PR (README.md:81). | 2026-10-27 |
| README | Run it on one machine with Docker and Compose v2 (L87) | TRUE | install.sh:17–22 (checks `docker` and `docker compose version`) | 2026-10-25 |
| README | `./install.sh`, then open http://localhost:3000 (L92–95) | TRUE | install.sh:54 (prints `http://localhost:3000`) | 2026-10-25 |
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
| bring-your-own/index.mdx:6 | On Connect your agent, choose **Use my own agent** | TRUE | en.json:1620 (`byo`: "Use my own agent") | 2026-10-26 |
| bring-your-own/index.mdx:14 | Claude Code: "Connect on a Mac through the web setup" | TRUE | V2AgentBYO.tsx:104 offers the listener on mac for Claude only; workspace-trust.js:93 refuses a non-darwin workspace. Lily ruled 10-25 that Claude answers @mentions on macOS only | 2026-10-26 |
| bring-your-own/index.mdx:17, codex.mdx:7 | Codex: "Connect on a Mac through the web setup" and "The Codex listener runs on macOS" | TRUE | V2AgentBYO.tsx:104 offers the mac listener for Codex; the macOS half only | 2026-10-26 |
| bring-your-own/index.mdx:17, codex.mdx:7, :12 (pre-fix :3, :6, :11) | Codex listener works on Linux (was offered in the app at V2AgentBYO.tsx:104) | FALSE | Lily 10-26 06:12Z: codex 0.164 fails bootstrap on Linux, 0.144 reaches the model call; not verified end to end. Fixed here: "macOS; Linux not yet tested" on codex.mdx:7 and :12 (were :3, :6, :11) and index.mdx:17; in-app copy en.json:1545, en.json:1612, zh-CN.json:1605, zh-CN.json:1671; guides.json:138, :795, :5726; on-my-computer.mdx:29. The in-app offer is narrowed to mac (V2AgentBYO.tsx:104) | 2026-10-26 |
| bring-your-own/index.mdx:20 | OpenCode card: "Attach from the CLI in an invite-only pod" | CUT | No code makes an OpenCode seat private: opencode.js:358-391 and :451-489 run public seats. Card narrowed to "Attach from the CLI" | 2026-10-26 |
| bring-your-own/index.mdx:23, deepseek-harness.mdx:7 | DeepSeek Harness: "Attach from the CLI on a Mac in an invite-only pod"; cannot run as a public seat | TRUE | dsh.js:44-45 refuses public trust; dsh.js:328-329 a confined seat needs darwin (Seatbelt) | 2026-10-26 |
| bring-your-own/index.mdx:30 | MCP gives an interactive session Commonly tools; a listener answers @mentions while you are away | TRUE | MCP connect block at V2AgentBYO.tsx:957; commonly-mcp/src has no poll loop (tools.js:231 is an ack call); the listener is `commonly agent run` (agent.js:3858) | 2026-10-26 |
| claude-code.mdx:9, codex.mdx:9, codex.mdx:4 | Needs Node.js 20 or later | TRUE | cli/package.json:65-67 `engines.node >=20.0.0` | 2026-10-26 |
| claude-code.mdx:9 | Claude Code signed in on that Mac | TRUE | claude.js:236-238 names the macOS Keychain credential that Claude's sign-in uses | 2026-10-26 |
| claude-code.mdx:12 | Select **Claude Code** and **macOS** on the Connect page | TRUE | V2AgentBYO.tsx:95 lists the OS choices; en.json:1611 names the OS when Claude cannot run | 2026-10-26 |
| claude-code.mdx:13, codex.mdx:13 | Get my connect command; the token is shown once | TRUE | en.json:1466 (`openConnect`); en.json:1552 (`keyOnce`: "a private key we show only once") | 2026-10-26 |
| claude-code.mdx:19-22 | Listener command: `npm i -g @commonlyai/cli@latest`, `export COMMONLY_API_URL`, `export COMMONLY_AGENT_TOKEN`, `commonly agent run <name> --adapter claude` | TRUE | V2AgentBYO.tsx:46 (install) and :980 (the copied listener template with `--adapter ${listenAdapter}`) | 2026-10-26 |
| codex.mdx:16 | Copied command installs `@commonlyai/cli`, sets URL and token, and runs `commonly agent run <name> --adapter codex` | TRUE | V2AgentBYO.tsx:980 with listenAdapter set to codex; codex is registered (cli/src/lib/adapters/index.js:23) | 2026-10-26 |
| claude-code.mdx:25, codex.mdx:16, work-in-your-repo.mdx:21 | MCP alone does not answer @mentions and does not start the listener | TRUE | commonly-mcp/src has no poll loop (tools.js:231 is an ack call); the listener is `commonly agent run` (agent.js:3858) | 2026-10-26 |
| opencode.mdx:7 | "OpenCode 1.19.3" is the version the guide covers | STALE | opencode.js:68 `TESTED_OPENCODE_VERSIONS = ['1.18.35', '1.19.0']`. Fixed here to name the tested versions | 2026-10-26 |
| opencode.mdx:12-13 | `commonly agent attach opencode --pod ... --env ...`, then `commonly agent run <name>` | TRUE | opencode is registered (cli/src/lib/adapters/index.js:25); attach takes `--env <path>` (agent.js:3678) | 2026-10-26 |
| deepseek-harness.mdx:6 (removed) | "Commonly CLI 0.1.122" is the supported path | CUT | No code pins a CLI version for dsh. The 0.1.122 pin exists only in docs/cli/dsh.md:16. Removed from the page | 2026-10-26 |
| deepseek-harness.mdx:7 | dsh 0.2.1-rc.2 is the supported version | TRUE | dsh.js:35 `TESTED_DSH_VERSIONS = ['0.2.1-rc.2']`; :344-345 refuses other versions | 2026-10-26 |
| deepseek-harness.mdx:12-13 | `commonly agent attach dsh ... --env ...`, then `commonly agent run <name>` | TRUE | dsh is registered (cli/src/lib/adapters/index.js:27); attach takes `--env` (agent.js:3678) | 2026-10-26 |
| work-in-your-repo.mdx:25 | On macOS, if every pod is private, the listener works in the folder you ran it from | TRUE | workspace-trust.js:6-8 (a pod must be confirmed private, not publicly readable, not listed, invite-only); :93 (darwin only); :112-119 (scratch folder otherwise) | 2026-10-26 |
| work-in-your-repo.mdx:27 | Reads files there and runs read-only git: `status`, `log`, `diff`, `show`, `blame` | TRUE | cli/src/lib/git-readonly.js:65 `READONLY_GIT_SUBCOMMANDS` | 2026-10-26 |
| work-in-your-repo.mdx:28 | Can't edit files, run commands, or fetch web pages | TRUE | Grants are off unless passed: agent.js:303-309 accepts only write and web, and only from `--allow` | 2026-10-26 |
| work-in-your-repo.mdx:29 | Can't read `.env` or `.env.*`; read-only git refuses them by name or path | TRUE | git-readonly.js:158-163 (ENV_FILE_SEGMENT and the excludes); :46 (committed .env refused by path or object id) | 2026-10-26 |
| work-in-your-repo.mdx:31 | Read-only git turns off external diff tools, conversion programs and signature checks, in submodules too | TRUE | git-readonly.js:21-22 and :112-116 (`--no-ext-diff --no-textconv`); :120-126 (the same off-switches reach a submodule's git as `-c` flags); :209-210 (`--submodule=diff` refused) | 2026-10-26 |
| work-in-your-repo.mdx:32 | Read-only git never contacts a remote | TRUE | git-readonly.js:40 (lazy fetch off, so a partial clone's missing objects stay missing); readonlyGitEnv sets GIT_NO_LAZY_FETCH and GIT_ALLOW_PROTOCOL=none (git-readonly.js:283-300) | 2026-10-26 |
| work-in-your-repo.mdx:35 | Otherwise reads only its scratch folder, and the start-up lines say why | TRUE | workspace-trust.js:90-107 (refusals with reasons); :112-119 (scratch folder as the cwd) | 2026-10-26 |
| work-in-your-repo.mdx:42-44 | `--allow write`, `--allow web` and `--allow write,web` are accepted on first run | TRUE | agent.js:3863 (`--allow <grants>`); agent.js:303-309 (WORKSPACE_SANDBOX_ALLOW) | 2026-10-26 |
| work-in-your-repo.mdx:52 | Grants fixed at first setup; change with `commonly agent detach <name> --force`, then rerun | TRUE | agent.js:315-329 (grants fixed when the token file is written; the message names detach --force) | 2026-10-26 |
| work-in-your-repo.mdx:54 | Only Claude Code listeners work in a folder for now | TRUE | workspace-trust.js:90-91 returns no workspace unless adapterName is claude | 2026-10-26 |
| en.json:1611 | "Claude Code can't answer @mentions from {{os}} yet" | TRUE | matches workspace-trust.js:93 and V2AgentBYO.tsx:104 | 2026-10-26 |
| V2AgentBYO.tsx:104, en.json:1545, en.json:1612, zh-CN.json:1605, zh-CN.json:1671, guides.json:138, :795, :5726, on-my-computer.mdx:29 | Codex works on a Mac or Linux computer (the Linux half) | FALSE | Same evidence as the Codex-on-Linux row. Copy changed to "Linux is not tested yet"; the in-app listener offer narrowed to mac (`listenerRunsOn`), per Lily's "macOS; Linux not yet tested" | 2026-10-26 |

## Connectors and grants

Owner: TASK-014. Source: `docs-site/concepts/connectors.mdx` and `docs-site/concepts/grants.mdx`.

The connectors page is a first-touch page. A row marked `first-touch` in the Page column needs a walk on prod by someone who did not write the claim, with a 390 and a 1440 screenshot. A `file:line` does not meet that bar, so a marked row is TRUE on file:line only until its walk lands.

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| connectors (first-touch) | Open Connectors in Commonly | WALKED | Prod, build 4fd217a, 2026-10-27, non-author, signed-in account. 390 and 1440 screenshots. File:line `frontend/src/v2/components/V2NavRail.tsx:38` | 2026-10-27 |
| connectors (first-touch) | Channels carry messages between a pod and an outside chat | CUT | Not walked: needs a live Slack or Telegram connection, which is a write. Cut 10-27 (TASK-014); restore on walk. | 2026-10-27 |
| connectors (first-touch) | Tools let an agent read another service after the connection owner grants access | TRUE | Read walked. Prod, 2026-10-27, non-author: a read-only Linear grant, and the granted agent listed the teams. No write grant was walked. Walked on prod 10-27, no screenshots; WALKED when the 390/1440 land. File:line `backend/routes/grants.ts:320, :430` | 2026-10-27 |
| connectors (first-touch) | Tools let an agent act in another service after the connection owner grants access | CUT | Not walked: the only grant walked was read-mode (a read-only Linear grant). Cut 10-27 (TASK-014); restore on a write-mode walk. | 2026-10-27 |
| connectors (first-touch) | Slack and Telegram are channels | TRUE | Prod, build 4fd217a, 2026-10-27, non-author: "Connect a channel" lists Slack and Telegram. Airtable also appears under Tools on prod; no docs page names it. Walked on prod 10-27, no screenshots; WALKED when the 390/1440 land. File:line `frontend/src/v2/components/V2ConnectorsPage.tsx:193–194`, `:1684` | 2026-10-27 |
| connectors (first-touch) | Linear is a tool you can grant today | TRUE | Prod, 2026-10-27, non-author: a read-mode Linear grant made from the Connectors UI; the granted agent listed the Linear teams. Walked on prod 10-27, no screenshots; WALKED when the 390/1440 land. File:line `backend/routes/hostedMcpConnect.ts:351, :697`; `backend/integrations/hostedMcp/linear.ts:28–31` | 2026-10-27 |
| connectors (first-touch) | Telegram: bind a private chat and choose which pods reach it | CUT | Partial walk: the channel list and pod picker were seen; the private-chat bind was not run. Cut 10-27 (TASK-014); the table row is removed. Restore on walk. | 2026-10-27 |
| connectors (first-touch) | Slack: authorize a workspace | CUT | Partial walk: "Add · one click in your workspace" was seen; OAuth was not started. Cut 10-27 (TASK-014); the table row is removed. Restore on walk. | 2026-10-27 |
| connectors | Slack: "then confirm the connection" | CUT | Removed from main by #2817 (e00b5c887). | 2026-10-26 |
| connectors (first-touch) | GitHub App: an instance administrator installs the app | TRUE | Prod, build 4fd217a, 2026-10-27, non-author: the page says the app is installed first, once, by an admin. Walked on prod 10-27, no screenshots; WALKED when the 390/1440 land. File:line `backend/routes/integrations.ts:239–262` | 2026-10-27 |
| connectors (first-touch) | GitHub App: the connection owner grants tools | CUT | Not walked: the GitHub App is not installed for the walk account. Cut 10-27 (TASK-014): the grant sentence is removed from the intro and the GitHub row. The page makes no claim that GitHub grants are unavailable, because the grant path exists at `backend/routes/grants.ts:346`. Restore on walk. | 2026-10-27 |
| connectors | GitHub App on commonly.me: "limited to the instance's own repository" | CUT | Removed from main by #2817 (e00b5c887). | 2026-10-26 |
| connectors (first-touch) | Linear: connect your account | TRUE | Prod, 2026-10-27, non-author: a Linear grant made from the Connectors UI on a signed-in account. Walked on prod 10-27, no screenshots; WALKED when the 390/1440 land. File:line `backend/routes/hostedMcpConnect.ts:351, :697` | 2026-10-27 |
| connectors (first-touch) | Linear: grant read access to an eligible pod | TRUE | Prod, 2026-10-27, non-author: a read-mode grant to an invite-only pod; the granted agent listed the Linear teams. Walked on prod 10-27, no screenshots; WALKED when the 390/1440 land. File:line `backend/integrations/hostedMcp/linear.ts:28–31, :64, :92–93`; `backend/services/outsiderGrantPodEligibility.ts:46–54` | 2026-10-27 |
| connectors | Live page shows a free account before any connection or tool grant | CUT | Removed from main by #2817 (e00b5c887). | 2026-10-26 |
| connectors | "Other tools visible in the list" | CUT | Removed from main by #2817 (e00b5c887). | 2026-10-26 |
| connectors | Two screenshots and captions | CUT | Not walked in time. The images stay in `docs-site/images` and are no longer referenced. | 2026-10-26 |
| connectors | The page lists unavailable connectors; a listed row is not a working connection | CUT | Removed from main by #2817 (e00b5c887). | 2026-10-26 |
| connectors (first-touch) | The grants guide explains how a connection owner limits tool access and revokes it | TRUE | Prod, build 4fd217a, 2026-10-27, non-author: the guide is live and covers audience, expiry and revoke. Walked on prod 10-27, 1440 screenshot only; WALKED when the 390 lands. File:line `backend/services/roomGrantService.ts:324–373`; `backend/routes/grants.ts:480–501` | 2026-10-27 |
| grants | A grant is scoped to a pod and the members allowed to use it, and can expire or be revoked | TRUE | `backend/models/RoomGrant.ts:28, :32–34` (target, audience snapshot, expiry); `backend/routes/grants.ts:371–379` (audience defaults to current members; each listed id must be one of them); `backend/services/roomGrantService.ts:233–239` (effective audience is the snapshot ∩ current members), `:242–243, :255–257` (expiry required and future), `:431` (expiry enforced on use); revoke `backend/routes/grants.ts:480–501`, `backend/services/roomGrantService.ts:390–396`, `backend/models/RoomGrant.ts:106–136` | 2026-10-27 |
| grants | A grant is a server-enforced capability record | TRUE | `backend/models/RoomGrant.ts:11–36` | 2026-10-26 |
| grants | It is not a credential, and revoking it does not replace the connector's credentials | TRUE | `backend/models/RoomGrant.ts:24–45` (no credential field); `:128–134` (revoke writes only `revokedAt` and `revokedBy`); `backend/models/AgentCredential.ts:41–58` | 2026-10-27 |
| grants | A connected integration's owner owns the connection | TRUE | `backend/routes/grants.ts:320` | 2026-10-26 |
| grants | Main's lifecycle: "creates a root grant for a pod or a seat" | FALSE | Fixed by this PR. `backend/services/outsiderGrantPodEligibility.ts:46`; `backend/routes/grants.ts:367–369, :405–417` | 2026-10-27 |
| grants | The connection owner creates a root grant for a pod | TRUE | `backend/routes/grants.ts:312, :320, :430` | 2026-10-27 |
| grants | The grant names tools, write mode, audience, budget, and expiry | TRUE | `backend/models/RoomGrant.ts:30–34` | 2026-10-26 |
| grants | An installed agent may attenuate a usable grant into a narrower child grant | TRUE | `backend/routes/grants.ts:438–473`; `backend/services/roomGrantService.ts:324–373` | 2026-10-27 |
| grants | The broker checks the grant before each tool call and records the outcome | TRUE | `backend/services/toolBrokerService.ts:834, :1105, :1210, :1430` | 2026-10-26 |
| grants | The connection owner can revoke; revocation cascades to children | TRUE | `backend/routes/grants.ts:480–501` (owner-or-admin check `:487–492`; routes `:500–501`); `backend/services/roomGrantService.ts:390–396`; `backend/models/RoomGrant.ts:106–136` | 2026-10-27 |
| grants | The root-grant route accepts GitHub App and hosted MCP, including Linear | TRUE | `backend/routes/grants.ts:346`; `backend/services/installable/toolInstallables.ts:248` | 2026-10-26 |
| grants | Linear exposes only read tools | TRUE | `backend/integrations/hostedMcp/linear.ts:28–31, :64, :92–93` | 2026-10-26 |
| grants | Every root grant, Linear included, works only in an eligible private pod | TRUE | `backend/services/outsiderGrantPodEligibility.ts:46–54`; `backend/routes/grants.ts:405` (unconditional call), `:457` (attenuation) | 2026-10-27 |
| grants | The server derives the installation and broker from the connection | TRUE | `backend/routes/grants.ts:321–322` (comment), `:350`, `:392–394` (caller's `brokerId` refused), `:428` (`brokerId` from the catalogue) | 2026-10-27 |
| grants | A grant targets a pod: `{ "kind": "pod", "id": "<podId>" }` | TRUE | `backend/services/roomGrantService.ts:13` | 2026-10-26 |
| grants | Main's seat target and seat audience | FALSE | Fixed by this PR. Create refuses seat targets at `backend/routes/grants.ts:367–369`, and the outsider gate refuses them too (`backend/services/outsiderGrantPodEligibility.ts:46`). The mint test asserts the 400 at `backend/__tests__/unit/routes/grants.mint.test.js:112–118` and the real gate at `:120–123`. | 2026-10-27 |
| grants | Main's seat grant is visible to its owner and seat | FALSE | Fixed by this PR. The read branch at `backend/routes/grants.ts:523–528` exists, but POST refuses seats (`:367–369`), and attenuation copies the parent's target (`backend/services/roomGrantService.ts:379`). | 2026-10-27 |
| grants | Pod grants default to the pod's current members | TRUE | `backend/routes/grants.ts:371–373` | 2026-10-26 |
| grants | Each listed audience identity must be a current member of the pod | TRUE | `backend/routes/grants.ts:374–379` | 2026-10-27 |
| grants | The read boundary follows the pod; anyone who can view it can inspect the grant and its call trail | TRUE | `backend/routes/grants.ts:514–533` (`gateGrantRead`; pod branch `:529–532`) | 2026-10-27 |
| grants | Older seat-targeted grants may appear in the list; only the connection owner and that seat can read them | TRUE | `backend/routes/grants.ts:367–369` (create refuses seat targets, so a seat grant predates that guard or comes from attenuating one, `backend/services/roomGrantService.ts:379`); `:523–528` (`gateGrantRead` seat branch: granter or that seat only); `:613–618` (the pod list includes seat grants whose target is a current member) | 2026-10-27 |
| grants | The API returns an effective audience, not a stale membership snapshot | TRUE | `backend/routes/grants.ts:100`; `backend/routes/grants.ts:586`, `:620–627` | 2026-10-27 |
| grants | The projected grant record fields | TRUE | `backend/routes/grants.ts:85–110` | 2026-10-26 |
| grants | The projection omits the connection and broker identifiers | TRUE | `backend/routes/grants.ts:94–107` (projected fields); `:578–579` (comment); `:588` (projection call) | 2026-10-27 |
| grants | `grantedBy` is the connection owner | TRUE | `backend/routes/grants.ts:119` | 2026-10-26 |
| grants | Use a human JWT for connection-owner and pod-management operations; use the agent runtime token only for operations available to an installed agent | TRUE | `backend/routes/grants.ts:312`, `:500–501`, `:600` (`auth`, which rejects agent tokens at `backend/middleware/auth.ts:44–45`); `:440–442` (attenuate, `agentRuntimeAuth`); `:540`, `:580` (reads, `dualAuth`) | 2026-10-27 |
| grants | Anyone who can view the pod can list the grants targeting it | TRUE | `backend/routes/grants.ts:600–608` | 2026-10-27 |
| grants | Example tool `github.list_issues` | TRUE | `backend/services/toolBrokerService.ts:198, :201` | 2026-10-26 |
| grants | Example `expiresAt` of 2026-10-01 | FALSE | Fixed by this PR, to 2027-12-31. 2026-10-01 is past and is rejected (`backend/services/roomGrantService.ts:255–257`). | 2026-10-26 |
| grants | `expiresAt` is required and must be in the future | TRUE | `backend/services/roomGrantService.ts:242–243, :255–257` | 2026-10-26 |
| grants | Create verifies connection ownership, target membership, enabled tools, and audience scope | TRUE | `backend/routes/grants.ts:320` (owner), `:367–370` (pod target and `ensureTargetAccess`), `:374–379` (audience), `:395–403` (enabled tools), `:405–417` (outsider gate) | 2026-10-27 |
| grants | An owner, an eligible pod member, or the target seat can read a grant | FALSE | Fixed by this PR. The pod branch has no owner exception (`backend/routes/grants.ts:529–532`). | 2026-10-27 |
| grants | Anyone who can view the pod can read a grant and its call trail | TRUE | `backend/routes/grants.ts:529–532` (gate); `:540` (calls route); `:580` (grant route) | 2026-10-27 |
| grants | Each connector call through a grant is recorded. The record keeps a digest of the arguments, not the arguments themselves | TRUE | `backend/services/toolBrokerService.ts:1078–1123` (`recordCall`, `argsDigest` at `:1113`); call sites `:1164, :1306, :1317, :1327, :1375, :1470`; `backend/models/ToolCall.ts:76, :99, :153–154`; the second writer `backend/services/approvalActionService.ts:608–633` also writes only `argsDigest`. Limit: a parked approval holds the raw arguments in `ApprovalAction.toolCall.canonicalArgs` from park (`backend/services/toolBrokerService.ts:1281`; `backend/models/ApprovalAction.ts:38–44`) until a terminal write unsets them (`backend/services/approvalActionService.ts:537, :857, :904, :1025`). These are call sites, not an exhaustive path audit. | 2026-10-27 |
| grants | A call record includes the tool, outcome, reason, approval identifier, timing, and an argument digest | TRUE | `backend/services/toolBrokerService.ts:1105–1121` (`ToolCall.create`: tool `:1112`, `argsDigest` `:1113`, `at` `:1114`, outcome `:1115`, reason `:1116`, approvalId `:1119`, durationMs `:1120`). The second writer (`backend/services/approvalActionService.ts:620–631`) sets no `at` or `durationMs`; `ToolCall.create` then stamps the write time (`backend/models/ToolCall.ts:258`, `record.at || new Date()`) and stores `duration_ms` as null (`:262`). So an approval-decision record has a time and no duration. | 2026-10-27 |
| grants | Attenuation is under the same pod eligibility rule | TRUE | `backend/routes/grants.ts:457` | 2026-10-27 |
| grants | The child cannot widen tools, audience, write mode, budget, or expiry | TRUE | `backend/services/roomGrantService.ts:338–339, :346–347, :349–351, :369–373` | 2026-10-26 |
| grants | Attenuation uses the agent runtime token | TRUE | `backend/routes/grants.ts:55–59, :440–442` | 2026-10-27 |
| grants | The owner revokes by DELETE or the POST revoke action, and both cascade | TRUE | `backend/routes/grants.ts:500–501` (both routes share `revokeHandler`, `:480–498`); `backend/models/RoomGrant.ts:106–136` | 2026-10-27 |
| grants | Connector installation does not grant access by itself | TRUE | `backend/routes/hostedMcpConnect.ts:36`; `backend/routes/integrations.ts:51`; `backend/services/installable/installableInstallationService.ts:21` (revoke only). The only grant creator is `backend/routes/grants.ts:430`. | 2026-10-27 |
| grants | Connector installation sets which capability is connected and where it is projected | TRUE | `backend/routes/integrations.ts:261–262`; `backend/services/installable/installableInstallationService.ts:165` | 2026-10-26 |
| grants | Credential owns "secret material and credential lineage" | FALSE | Fixed by this PR, reworded to "a hashed agent token and its lineage". Only a hash is stored (`backend/models/AgentCredential.ts:16, :43`); lineage is at `:27, :48, :87`. | 2026-10-26 |
| grants | Credential does not describe which tools a caller may invoke | TRUE | `backend/models/AgentCredential.ts:50`; `backend/controllers/authController.ts:275`; `backend/middleware/daemonAuth.ts:51–52` | 2026-10-26 |
| grants | Grant does not store or reveal the connector secret | TRUE | `backend/routes/grants.ts:85–110`; `backend/models/RoomGrant.ts:30–36` | 2026-10-26 |
| grants | Grant owns target, tools, audience, limits, and revocation | TRUE | `backend/models/RoomGrant.ts:30–36`; `backend/routes/grants.ts:500–501` | 2026-10-27 |
| grants | Link label "Connectors and Grants" points to `/concepts/connectors` | FALSE | Fixed by this PR. The label was at `docs-site/concepts/grants.mdx:145` on main; the page title is "Connectors" (`docs-site/concepts/connectors.mdx:2`). | 2026-10-26 |
| grants | The connectors page covers the installation and credential model | FALSE | Fixed by this PR. The page never mentioned credentials. | 2026-10-26 |
| grants | Agent Tools is the runtime-facing tool surface | TRUE | `docs-site/agents/tools.mdx:3` | 2026-10-26 |
| grants | The API routes listed in the code blocks | TRUE | `backend/routes/grants.ts:312` (POST `/`), `:439` (attenuate), `:500`, `:501` (revoke POST and DELETE), `:540` (calls), `:580` (grant read), `:600` (pod grants list) | 2026-10-27 |

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
