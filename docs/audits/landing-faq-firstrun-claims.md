# Landing FAQ and firstRun copy: claim audit

Audit of the six landing FAQ items (`frontend/src/content/landing-faq.json`) and the
claim-bearing `firstRun` keys (`frontend/src/i18n/locales/en.json`, lines 460–489). Audit SHA
`67dd25b21` (`main`). Every line number below is from that SHA.

## Scope and rules

- **Verdicts** follow [claim-table.md](claim-table.md). Only TRUE and FALSE are used here.
  TRUE needs a `file:line` on `main`, not another doc.
- **Per sentence.** Each sentence of the copy is one row. A sentence is FALSE if any reader it
  addresses is told something the code does not do. "Such as" lists are judged on the class.
- **Evidence age.** Evidence is no older than 14 days. All rows are dated 2026-10-27.
- **No copy edits in this audit.** Every FALSE row is fixed by the launch copy PR. A staff session
  writes that copy, and it is gated with an Opus review and rendered.
- **Split.** The landing FAQ and firstRun copy ship before the freeze. The other 27 uncovered
  pages, the connector and tool keys, and zh-CN move to TASK-020, post-launch.
- **Diagrams.** Cut from scope. Nothing on `main` names a diagram deliverable for this copy.
  The matches for "diagram" are prose in `frontend/src/content/guides.json` (`:1689`, `:1926`)
  and in `docs/`.

## Claim table

| Page | Claim | Verdict | Evidence | Date |
|---|---|---|---|---|
| Landing FAQ 1 | Commonly is an open-source (Apache-2.0), self-hostable workspace where a team and its AI agents share a pod. | TRUE | `package.json:4` (Apache-2.0); `install.sh:57` (compose `up -d --build`); `backend/services/agentIdentityService.ts:691` (`ensureAgentInPod`) | 2026-10-27 |
| Landing FAQ 1 | Claude Code, Codex and OpenCode join from your own machine, or you can use the hosted agent, and everyone works in the same chat and task board. | FALSE | The connect page offers `claude` and `codex` only (`frontend/src/v2/components/V2AgentBYO.tsx:73`). The OpenCode handoff is Mac-only (`backend/services/byoHandoffService.ts:115-118`). Codex cannot join from Windows (`frontend/src/i18n/locales/en.json:1612`). Hosted path: `V2AgentBYO.tsx:546`, `en.json:1618`. | 2026-10-27 |
| Landing FAQ 2 | Commonly is an open-source (Apache-2.0) workspace built for teams of people and AI agents. | TRUE | `package.json:4` | 2026-10-27 |
| Landing FAQ 2 | A pod has a chat, a task board that agents claim work from, and decision cards where an agent asks a person before acting. | FALSE | Claim route: `backend/routes/tasksApi.ts:594`. Decision card creation: `backend/routes/agentsRuntime.ts:4126`. The only pre-action gate is the approval card for connector writes (`backend/services/toolBrokerService.ts:1256-1276`). Decision cards are a prompt frame for genuine forks, not a gate on every action (`cli/src/lib/enforcement.js:38-40`). | 2026-10-27 |
| Landing FAQ 2 | You can self-host it or use `commonly.me`. | TRUE | `install.sh:57` (self-host); `backend/routes/auth.ts:262` (default app origin `https://commonly.me`); `backend/middleware/corsPolicy.ts:14` (origin allowlist). A live walk is outside this audit. | 2026-10-27 |
| Landing FAQ 3 | In a Commonly pod, choose "Use my own agent", then "Get my connect command", and run the lines it shows on your Mac. | TRUE | `en.json:1620` (`mode.byo`, "Use my own agent"); `en.json:1529` (`agentByo.actions.install`, "Get my connect command"), rendered at `V2AgentBYO.tsx:1321`; Mac listener for Claude Code (`V2AgentBYO.tsx:103-105`, `listenerRunsOn`). | 2026-10-27 |
| Landing FAQ 3 | Your own Claude Code then answers `@mentions` in the pod, in a thread. | FALSE | Failing clause: "in a thread". A reply is one top-level post (`cli/src/lib/enforcement.js:776-780`). A thread is used only past the chunk limit, and its continuations carry `threadRootId` (`enforcement.js:791-821`, `:817`). The threading cue says a plain post broadcasts to the channel (`backend/services/agentMentionService.ts:504`). | 2026-10-27 |
| Landing FAQ 3 | On Linux or Windows, the same page connects your Claude Code session over MCP. | TRUE | MCP commands for both OSes: `V2AgentBYO.tsx:957-965` (`claudeSnippet`, `claudeSnippetWindows`). Caveat: an MCP connection does not answer `@mentions` (`en.json:1611`). This sentence does not claim it does. | 2026-10-27 |
| Landing FAQ 4 | Commonly is open source (Apache-2.0) and self-hostable. | TRUE | `package.json:4`; `install.sh:57` | 2026-10-27 |
| Landing FAQ 4 | Several agents, such as Claude Code, Codex, OpenCode and a hosted agent, work alongside people in one pod. | TRUE | Judged on the class, several agent runtimes in one pod: `backend/services/agentIdentityService.ts:691`; connect paths `V2AgentBYO.tsx:73`; hosted path `V2AgentBYO.tsx:546`. The named OpenCode example fails in Landing FAQ 1 (`byoHandoffService.ts:115-118`), so the launch copy PR should narrow it. | 2026-10-27 |
| Landing FAQ 4 | They claim tasks on a shared board, post what they tried, and ask a person on a decision card when the call is theirs. | TRUE | Claim: `backend/routes/tasksApi.ts:594`. Post an update: `backend/routes/tasksApi.ts:787`. Decision card for a genuine fork that needs a human choice: `cli/src/lib/enforcement.js:38-40`. | 2026-10-27 |
| Landing FAQ 5 | In a Commonly pod, Claude Code, Codex and OpenCode from teammates' machines, plus a hosted agent, share one chat and task board with the people on the team. | FALSE | Failing clauses: OpenCode from a teammate's machine (`V2AgentBYO.tsx:73`; `byoHandoffService.ts:115-118`), and Codex from a Windows machine (`en.json:1612`). The hosted agent is real (`V2AgentBYO.tsx:546`). The shared board resolves each claimer for all pod members (`frontend/src/v2/components/V2PodBoard.tsx:244`). | 2026-10-27 |
| Landing FAQ 5 | Activity shows what each agent claimed and finished, and what needs a person. | FALSE | Failing clause: "what each agent claimed". Activity lists a board item only when it has a `lastUpdate` (`frontend/src/v2/components/V2ActivityPage.tsx:796-803`) and names no claimer. The claimer lookup exists only on the board (`V2PodBoard.tsx:244`). "Finished" is the status mapping (`backend/services/activityService.ts:254-286`). "Needs a person" is pending decision items (`activityService.ts:1416`). | 2026-10-27 |
| Landing FAQ 6 (premise) | Anthropic recommends one agent loop over subagents. | FALSE | No source on `main` states or supports this. A TRUE verdict needs a `file:line` on `main`, and the only match for the phrase is the FAQ entry itself (`frontend/src/content/landing-faq.json:23`). The launch copy PR must source the claim or cut it. | 2026-10-27 |
| Landing FAQ 6 | For a single agent, we agree: each expert should be one strong loop, and Commonly doesn't split an agent into subagents. | FALSE | Failing clause: "Commonly doesn't split an agent into subagents". The Claude Code adapter cues parallel read-only subagents for non-public seats (`cli/src/lib/adapters/claude.js:113-116`, applied at `:1077`). The gateway caps subagent concurrency at 4 (`backend/services/agentProvisionerService.ts:929-932`). | 2026-10-27 |
| Landing FAQ 6 | Across a team, work still divides by expertise and ownership, so there are several of those experts, each running under its own owner. | TRUE | Each agent has a required installer (`backend/models/AgentRegistry.ts:261`). Runtime tokens are issued for an owner (`backend/routes/registry/agent-tokens.ts:224`). "Divides by expertise" is framing that no code asserts. | 2026-10-27 |
| Landing FAQ 6 | A pod is where they work together: your Claude Code and a teammate's agent, each a named member, sharing one thread and one board with the people who run them. | FALSE | Failing clause: "sharing one thread". A pod is one room with many threads. Its messages are scoped by `podId` (`backend/models/pg/Message.ts:271`), a thread is one root plus its replies (`Message.ts:281-284`), and the UI groups messages per root (`frontend/src/v2/components/V2Thread.tsx:339`). The membership clause holds: agents join pods as members (`backend/services/agentIdentityService.ts:691`), and the agent's display name is on its User row (`backend/models/User.ts:135`). The shared board holds (`V2PodBoard.tsx:244`). | 2026-10-27 |
| Landing FAQ 6 | A task claimed on the board shows as taken to everyone, and a connector grant gives one agent read access to one tool without handing over your keys. | FALSE | Failing clause: "a connector grant gives one agent read access to one tool." A grant can list several tools (`backend/models/RoomGrant.ts:29`), allow `write` or `write-with-confirm` (`RoomGrant.ts:12`, `:30`), and list several audience members (`RoomGrant.ts:33`). The claimed-task clause holds: a claimed task shows its claimer to pod members (`V2PodBoard.tsx:244`; claim route `backend/routes/tasksApi.ts:594`). The no-credential clause holds: the broker returns a result with no credential (`backend/services/toolBrokerService.ts:1352`, `:1360-1365`). | 2026-10-27 |
| firstRun `lede` (en.json:463) | Connect Claude Code or Codex, or run one here, then start a private conversation without leaving your workspace. | TRUE | Connect: `V2AgentBYO.tsx:73` (`claude`, `codex`). Run here: `en.json:1618`, `V2AgentBYO.tsx:546`. Private 1:1 room: `V2FirstRunHero.tsx:211` (POST `/api/agents/runtime/room`); `backend/routes/agentsRuntime.ts:917`. Codex has no Windows path (`en.json:1612`), so the "or" still holds there through Claude Code. | 2026-10-27 |
| firstRun `connect.text` (en.json:469) | Generate its private runtime token and copy the setup command for your tool. | TRUE | Issue: `V2AgentBYO.tsx:733-736` (POST without `force`); route `backend/routes/registry/agent-tokens.ts:157`. Setup commands: `V2AgentBYO.tsx:957-965`. Caveat: if a token already exists, nothing is generated. The page opens the replacement confirmation instead (`V2AgentBYO.tsx:737-740`; copy `en.json:1555`). | 2026-10-27 |
| firstRun `connect.openSetup` (en.json:470) | Open connection setup | TRUE | `V2FirstRunHero.tsx:263-274` (link to `/v2/agents/byo`, new tab). | 2026-10-27 |
| firstRun `start.waiting` (en.json:476) | Waiting for your agent to connect… | TRUE | Shown until `status.connected` (`V2FirstRunHero.tsx:281-283`). Status is polled every 3 s (`V2FirstRunHero.tsx:9`, `:118-152`) from `backend/routes/users.ts:132`. | 2026-10-27 |
| firstRun `start.connectedStatus` (en.json:475) | ✓ Connected | TRUE | Shown when `status.connected` (`V2FirstRunHero.tsx:282-283`). The flag comes from `backend/routes/users.ts:132`. | 2026-10-27 |
| firstRun `hello.text` (en.json:480) | Your agent gets its own durable identity and private 1:1 with you. | TRUE | Durable: the agent User row is created once (`backend/routes/registry/agent-tokens.ts:202`). Rotation revokes tokens, not the user (`agent-tokens.ts:208-222`). Private 1:1: an `agent-room` must have exactly two members (`backend/services/agentIdentityService.ts:44`); the room is find-or-create (`backend/routes/agentsRuntime.ts:917`). | 2026-10-27 |
| firstRun `errors.statusUnavailable` (en.json:486) | Connection status is temporarily unavailable. We'll keep checking. | TRUE | Set on a failed poll (`V2FirstRunHero.tsx:77-79`). The interval keeps running (`V2FirstRunHero.tsx:118-152`). | 2026-10-27 |
| firstRun `errors.roomFailed` (en.json:487) | Could not open your 1:1 yet. Try again. | TRUE | Set on a failed room request (`V2FirstRunHero.tsx:226-231`). The button stays enabled (`:299` disables it only while opening; `:230` clears that state), labelled "Say hello" (`en.json:482`). So "Try again" means pressing it again. A server message replaces this copy (`V2FirstRunHero.tsx:227-229`). | 2026-10-27 |

## FALSE rows

These are not fixed in this PR. The launch copy PR corrects each failing clause or cuts it.

1. **Landing FAQ 1, sentence 2.** OpenCode joins from your own machine: the connect page does not
   offer it, and the handoff is Mac-only. Codex joins from your own machine: there is no Windows path.
2. **Landing FAQ 2, sentence 2.** "Decision cards where an agent asks a person before acting": the
   only pre-action gate on `main` is the approval card for connector writes.
3. **Landing FAQ 3, sentence 2.** Replies come "in a thread": the default is one top-level post.
4. **Landing FAQ 5, sentence 1.** OpenCode from teammates' machines, and Codex from a Windows machine.
5. **Landing FAQ 5, sentence 2.** "What each agent claimed": Activity names no claimer.
6. **Landing FAQ 6, premise.** "Anthropic recommends one agent loop over subagents": no source on `main`.
7. **Landing FAQ 6, sentence 1.** "Commonly doesn't split an agent into subagents": the Claude Code
   adapter cues subagents, and the gateway caps them at 4.
8. **Landing FAQ 6, sentence 3.** "Sharing one thread": a pod is one room with many threads, one per
   root message.
9. **Landing FAQ 6, sentence 4.** "Read access to one tool": a connector grant can list several tools
   and allow `write` or `write-with-confirm`.

## Checks closed

- **commonly.me as a hosted service.** A non-test code cite exists: `backend/routes/auth.ts:262`
  (default app origin) and `backend/middleware/corsPolicy.ts:14`.
- **firstRun token branch.** The hero never calls the token route. Its link opens the setup page,
  which issues without `force`. If a token already exists, the page asks for confirmation instead
  of rotating it (`V2AgentBYO.tsx:737-740`). The hero never forces rotation.
- **"Try again" state.** The button is re-enabled after a failed room request (row above).

## Not scored

- The six FAQ questions are fixed and not scored (`frontend/src/v2/landing/landingFaq.ts:4-8`).
  "Isn't Commonly a multi-agent system?" is a question, not a claim.
- firstRun labels with no claim are not rows: eyebrow, title, skip, reopen, step titles, and
  button labels. The eyebrow "Your first five minutes" (`en.json:461`) is a time estimate with no
  code behind it. The launch copy PR decides whether to keep it.
