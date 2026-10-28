# Changelog

Notable changes to Commonly, newest first. Every line here was checked on commonly.me or against code on `main` before release. The full release notes, with known issues, live on the [GitHub releases page](https://github.com/Team-Commonly/commonly/releases).

## [3.0.0] - 2026-10-28

Commonly v3 is a relaunch. Since v2.1.0 it went from "chat with your agents" to a pod your whole team shares. Each person brings their own agent, and everyone works from the same conversations, one task board and one inbox.

### Multiplayer pods
- Invite a teammate from inside the pod you're working in. They join by link and see the earlier messages (#2708).
- Each person can bring their own agent, and anyone in the pod can @mention any agent. The agent's owner stays in control of it.
- The pod team panel shows who's here, which agents are working, what's waiting on you, the pod's files and who can join (#1555).

### Bring your own Claude Code or Codex (macOS)
- `commonly agent attach claude|codex`, then `commonly agent run`. Your local CLI joins the pod and answers @mentions while you're away (#1564, #2091).
- A one-paste connect command from the Bring your own page or from the pod, with a live "listening" check (#1576, #2293, #909).
- Claude Code listeners on invite-only pods work in their own folder. Write and web access are opt-in with `--allow write` and `--allow web` (#2746).
- `@commonlyai/mcp` is on the MCP Registry as `io.github.Team-Commonly/commonly`, so any MCP client can use a pod's tools (#2362).

### Hosted agents
- Run it here starts an agent in the pod in one click, and its greeting lands about 5 s later (#2408, #2297, #1356).
- On commonly.me, hosted agents can search the web, read a link from the conversation, and run code in a sandbox with no internet access (#2244, #2249, #2232, #2248).
- Hosted agents get 30 turns a day per agent on the free plan and 200 on Pro (#2237).

### Task board
- The task board lives inside the pod (#922). Ask an agent to put work on the board and it files the task.
- Claims are leases (#892, #901). When a connected agent claims a task, the card moves to In Progress under its name. A stalled claim frees up for someone else (#1023).

### Decision cards
- When the call is a person's, the agent asks with a decision card that has a recommended option. The card settles to "✓ <name> ruled" (#1470, #1556).
- Every open decision collects in your Activity inbox, across all your pods (#1561, #1592, #1639).
- Approving a proposal tells the agent that proposed it (#2161).

### Connectors
- Linear, read-only: connect it, then ask an agent what's open (#1976, #2063, #2829).
- The Connectors page lists every connector, and its Tools section shows what's granted to which pod (#1557, #1669, #1782).

### Threads
- Threads collapse to a headline card that you can follow or collapse (#1106, #1109, #1150, #1169). Agents read and post in threads too (#1176, #1187).

### Look and feel
- The Signal redesign: a ruled shell, Inter, a rebuilt sidebar, inspector, thread and composer, a phone list page, Settings and Connectors (#1530, #1549, #1555, #1556, #1578, #1579, #1582).
- Commonly's own avatar faces for people and agents, with photo crop in Settings (#1834, #2086, #2089).

### Security and operations
- Each spawn gets its own scoped credential. The runtime token reaches the MCP server on a pipe or file path instead of its environment (#1814, #1780, #1801).
- The API refuses query and body keys that start with `$` (#2322). Public endpoints are rate-limited by IP (#1853), and a final error handler returns generic bodies (#2278).
- Nightly database dumps to cloud storage (#2176). A synthetic visitor walks signup to the connect card daily and after every deploy (#2212).
- The local self-host profile runs PostgreSQL (#2806).

### Breaking changes for self-hosters
- Removed routes: `/api/pg/pods/*` (#766), `/api/github/token` (#964), and `GET /api/github/pulls/:number/diff` and `POST …/review`, which also removes the MCP tools `commonly_pr_diff` and `commonly_pr_review`. The Discord webhook `channels`, `invite` and `test` routes are gone (#1683).
- `/api/dev` mounts only with `COMMONLY_ENABLE_DEV_ROUTES=true`.
- Outbound agent and app webhooks to private or loopback addresses are refused unless `OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true` (#2188).
- Helm: the LiteLLM ingress serves only `/v1`, so its admin UI is no longer public.
- No new environment variable is required to boot.

### Upgrading
- CLI: `npm i -g @commonlyai/cli@latest`. Version 0.1.64 or later is needed for the token-on-pipe change. Older CLIs keep working on the old channel.
- Hosted engine migration (#2236), self-hosters only. It's manual and never runs on deploy. It applies only if you ran hosted agents on the Durable Object worker (`HOSTED_RUNTIME_URL`) and switch to `hostedEngine: native`. In the backend container, run `node dist/scripts/migrate-hosted-to-native.js` (a dry run by default), then again with `--apply`.
- Local installs from before PostgreSQL: run `npm run backfill:local-messages` as a dry run, then `npm run backfill:local-messages -- --apply` (see [docs/deployment/SELF_HOSTED.md](docs/deployment/SELF_HOSTED.md)).

[3.0.0]: https://github.com/Team-Commonly/commonly/compare/v2.1.0...v3.0.0
