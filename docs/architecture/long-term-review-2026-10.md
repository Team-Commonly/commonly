# Long-term review: what to refactor, and what to leave alone (2026-10)

**Status:** Full report. The row's notes and two database counts are still open (see *Still open*). Anything that arrives by 2026-10-25 01:00Z lands on this same PR, so don't merge before then.
**Asked by:** the CTO (TASK-438).
**Measured at:** `main` `0b22729fa` (2026-10-24 03:59Z) and GitHub at 2026-10-24 05:12Z, unless a line says otherwise.

## The rule

Refactor only with numbers. Each item below names three things:

- the failure it removes, with the incident, PR or measured cost behind it;
- the effort, in implementor-days, including the usual two review rounds;
- the number that should move once it ships.

An idea with no number behind it goes under **Don't**, along with the condition that would change that.

## The finding

1. **The largest measured costs are in the pipeline, not in the code.** In 48 hours, 86% of agent turns posted nothing. A slow PR spends its time waiting. In the slowest tenth, 60% of the open time came after the PR was cleared, and 27% went to waiting for a gate. The author answering a HOLD took 3%.
2. **Most of tonight's incidents, and most of the 90-day fix hotspots, are one fact kept in several places.** Credentials live in three stores. Two URLs are read under four environment names. Agent identity is written from 11 places. The task revision is `updatedAt`.
3. **The usual rewrite candidates have numbers that say to leave them alone.** That covers the language, microservices, CI speed, a token pipeline, auth and Socket.io.

## Sources

- **Git history.** `main` at `0afed7ba1`, from 2026-07-26 00:00Z (90 days): 1,484 non-merge commits, 39% of them typed `fix`.
- **GitHub lists, each capped by the API:**
  - the last 600 merged PRs, created 2026-09-23 to 10-24 and read at 10-24 05:53Z;
  - the last 200 Deploy Dev runs (09-04 to 10-24);
  - the last 400 Tests runs (10-23 15:32Z to 10-24 05:08Z).
- **PR timelines** for the 150 PRs opened in the 48 hours to 2026-10-23 22:45Z. The list was read from GitHub at 10-24 05:12Z, and the event timeline of each merged or open PR at 05:30Z. They give when each PR was opened, pushed, marked ready, gated, queued and merged. A gate verdict is a review whose last line is `GATE: PASS` or `GATE: HOLD`.
- **Fleet logs** for the same 48 hours, from an internal SRE report. They give turns, wakes, timeouts, failures and LiteLLM status codes. The same report gives the row created → claimed times.
- **Import-graph reachability** from `frontend/src/index.tsx`, `backend/server.ts` and `cli/src/index.js`, at `0afed7ba1`.
- **Tonight's incident list**, as given with TASK-438.
- **The Raft study** (internal, 2026-10-23), cited by name only.

The commands are in *How to re-measure*, at the end. A count marked *keyword* comes from grepping commit subjects, so treat it as an upper bound.

## Do now

Items are ranked by measured cost removed per day of effort.

### 1. Finish receive ≠ wake, and make settings match what runs (in flight)

**Removes:** turns that post nothing, and seats that miss a wake on their own row.

**Evidence:**

- **Turns.** In 48 hours there were 7,518 turns, and 86% posted nothing. The wakes behind them were 9,200 `message.posted`, 1,271 mentions and 297 heartbeats.
- **Install config.** Of the 85 active installs:
  - 17 woke on every pod message;
  - 23 had board wakes explicitly off, so a row assigned in those pods woke nobody. This was fixed on 10-23 in the pods where those seats hold rows.
- **Spawn rate.** The first two config changes moved hourly spawns from a 405 baseline to readings between 222 and 404. Readings still spike: 471 came during a broadcast mention and a deploy, and 700 at 03:54Z on 10-24 is still being diagnosed. One hour is not a trend.
- **Configured ≠ running.** Tonight, a skills directory resolved on one host only. It was fixed on 10-23.
- **The CLI loop.** `cli/src/commands/agent.js` (3,746 lines) took 26 fix commits in 90 days.
  - Thirteen of them fixed wake, claim, cascade or retry semantics: #759, #794, #906, #973, #1010, #1027, #1047, #1092, #1166, #2257, #2445 and #2532, plus one unnumbered.
  - None names a type error.

**Shape:**

- The kernel owns the wake decision. Only an addressed event wakes a seat: a mention, a change to its own row, a reply in its thread, or a reference to its task or PR.
- Everything else arrives as a digest at the next wake.
- The CLI becomes a thin consumer that spawns when the kernel says so.
- Two pieces are in flight:
  - own-row board wakes are TASK-414 (#2561, open);
  - settings that show what actually runs are TASK-434 (#2573, open) and TASK-435.
- The shape was cross-checked against the Raft study.

**Effort:** in flight. Thinning the CLI loop takes 2–3 days once #2561 and #2573 merge.

**Moves:**

- turns that post nothing, from 86% to under 40%;
- spawns per hour, to at least 60% below the 405 baseline as a daily average;
- wake-semantics fixes in `agent.js`, from about 4 a month to 0–1.

### 2. Route gate events from GitHub to whoever acts next (2 days)

**Removes:** PRs that wait on a gate, or sit cleared and unqueued, because the ask or the clearance lived only in pod chat.

**Evidence** (the 150 PRs opened in the 48 hours to 10-23 22:45Z):

- **The interim's p90 was too low.** At the window's end, opened → merged measured 61 minutes median and 7.2 hours p90. That counted only the PRs that had already merged. By 10-24 05:12Z, 107 had merged, at 1.9 hours median and 10.7 hours p90. If the 13 non-draft PRs still open merge, the p90 will be at least 14.7 hours.
- **The time goes to waiting, not to fixing.** The slowest tenth was 11 merged PRs, open 209 hours between them. This is what that time waited on:

  | Waiting on | Share |
  |---|---|
  | a merge: the PR had a PASS at its head, and nobody had queued it | 45% |
  | a merge, while the PR stayed a draft after its PASS | 15% |
  | a gate verdict | 27% |
  | the author, still drafting | 8% |
  | the author, answering a HOLD | 3% |
  | the merge queue itself | 1% |

  All 107 merged PRs split much the same way: 57% after a PASS, 22% waiting for a gate, and 4% on the author answering a HOLD.
- **A few long waits make the tail.** The median wait for a gate verdict was 7 minutes, and the median wait from a PASS to the queue was 2 minutes. But 11 waits from a PASS to the queue ran past 4 hours, and so did 4 waits for a verdict. Seven of those 11 ended in the same half hour, when someone queued a batch. Some of that waiting is deliberate, such as during a deploy freeze, and nothing on the PR says which.
- **A HOLD is answered fast.** Across 135 HOLDs, the next verdict came 7 minutes later at the median and 42 minutes at p90. The first verdict was a HOLD on 65 of the 135 PRs that got one.
- **Cleared PRs sit.** At 05:12Z, 11 of the 13 non-draft PRs still open had a PASS as their latest verdict. Those PASSes were 2.4 to 42.5 hours old.
- **The asks are in chat.** Only 32 of the 150 PR bodies name their gate. The other asks went to pod chat, which nothing that watches PRs can see.
- **The merge queue is not the wait.** `main` merges through a GitHub merge queue, and the Tests workflow runs on it (`.github/workflows/tests.yml:18`). The 107 merges took 116 passes through the queue, so 9 times a PR was sent back. The queue took 3% of all open time. A cleared PR waits for someone to queue it.

**Shape:**

- Build on the GitHub App receiver. It already verifies review events (`backend/routes/webhooks/github.ts:56`) and posts cards into a bound pod (`backend/services/githubGigService.ts`). It is off by default, and each instance switches it on (`k8s/helm/commonly/values.yaml:282`).
- Read only a review's last line, and only from the accounts the gates post from. Copy nothing else from the review, which keeps the rule at `githubGigService.ts:60–61`.
- On each event, tell whoever acts next:
  - a PR opened, or pushed after a HOLD: the gate its body names;
  - `GATE: HOLD`: the author's seat, found from the task row that links this PR;
  - `GATE: PASS` at the PR's head: one ready-to-merge list, oldest first, for whoever merges.
- A PR that should wait stays a draft, or says why on the PR, so the list holds only PRs that can go.
- Whether a PASS at the head should queue the merge by itself is a ruling for the people who merge. The list helps either way.

**Effort:** 2 days. The receiver, the signature check and delivery dedupe exist. The work is the verdict parse, the routing and the list.

**Moves:**

- opened → merged p90, read a week after the window closes, from at least 14.7 hours to under 4;
- PR bodies that name their gate, from 21% to over 90%;
- waits longer than 4 hours from a PASS to the queue, from 11 in the window to 0, apart from deliberate holds.

### 3. Checkpoint before the turn cap, and slice rows to fit (1 day)

**Removes:** turns that the 45-minute cap kills, along with their work.

**Evidence:**

- There were 71 timeouts in 48 hours, which is at most 53 seat-hours (71 × 45 minutes).
- They concentrate on implementor seats working on page-sized slices.
- On 10-23 they were confirmed as genuinely long turns, not a slow model.

**Shape:**

- At 40 minutes, the CLI tells the seat to commit, push a checkpoint and stop.
- Rows are sliced to one page or one component.

**Effort:** 1 day.

**Moves:**

- timeouts per 48 hours, from 71 to under 15;
- timed-out turns that lose a commit, to 0.

### 4. One source for the instance URL (1 day)

**Removes:** non-production instances that link to production, call back to it, or advertise it.

**Evidence:**

- **Three incidents in two days:**
  - staging's chart pointed the API URL at production (#2529);
  - staging's API rejected its own frontend under CORS (#2481);
  - connect commands printed production's API URL instead of the instance's (#2568, TASK-428, open).
- **Four environment names cover two values:**

  | Name | Reads |
  |---|---|
  | `PUBLIC_APP_URL` | 5 |
  | `FRONTEND_URL` | 15, in 13 files |
  | `PUBLIC_API_URL` | 2 |
  | `BACKEND_URL` | 6 |

- **The chart sets only `FRONTEND_URL` and `BACKEND_URL`.** So on every other instance, three `PUBLIC_APP_URL` readers link to production: `telegramBridgeService.ts:340`, `slackBridgeService.ts:257` and `decisionCardReply.ts:76` (filed as TASK-285).
- **Literals.** 30 lines in 21 product files carry a production URL literal, and about 11 of them are environment fallbacks.

**Shape:**

- One config module owns the app URL and the API URL.
- Outside local development and tests, a missing value is a boot error, never a silent production default.
- A lint rule bans the literal outside that module.

**Effort:** 1 day.

**Moves:**

- production literals outside the module, from 30 to 0;
- instance-URL incidents, to 0 per quarter.

### 5. One credential store (3–5 days)

**Removes:** a revoke or rotation that misses one of the stores.

**Evidence:**

- **Three stores.** Agent runtime credentials live in three places:
  - the `AgentCredential` collection;
  - `User.agentRuntimeTokens` (`backend/models/User.ts:173`);
  - `AgentInstallation.runtimeTokens` (`backend/models/AgentRegistry.ts:220`).
- **ADR-026 Phase 0 left the move half done.** It added the collection "additive by design" (`backend/models/AgentCredential.ts:7–9`), so auth reads the collection first and then falls back to the embedded records.
- **Spread.** 32 non-test backend files touch at least one store, and 6 of them touch all three.
- **The same class, fixed five times in six weeks:**
  - token rotation made total (#1698, 09-12);
  - revoke kills a token in every store (#2202, 10-15);
  - revoke on the last uninstall (#2221, 10-16);
  - a credential retirement that did not reach everywhere it needed to (#2521, 10-23);
  - revoked keys still shown as connected (#2560, 10-24), plus three follow-up rows from tonight.
- **Keyword count.** 73 fix subjects in 90 days name tokens, credentials, revoke or auth.

**Shape:**

1. Backfill the collection from both embedded arrays.
2. Move every reader and writer to the collection. Auth keeps its fallback to the embedded records and logs every hit, and a revoke keeps clearing all three stores.
3. After 14 days with no fallback hits, delete the embedded fields and the fallback code.

**Effort:** 3–5 days. The backfill is about a day; the 32 files are the rest.

**Moves:**

- the stores, from three to one;
- "a revoke missed a store" fixes, to 0 per quarter.

### 6. One way to create an agent identity (3–4 days)

**Removes:** an agent that exists in one collection but not the next, which surfaces as "Agent not found in registry".

**Evidence:**

- **Tonight.** A self-serve install for a local agent wrote no registry row, so the agent could not be found (#2516).
- **Six collections.** Creating one agent writes to up to six of them:

  | Collection | Write sites | Files |
  |---|---|---|
  | `AgentInstallation` | 28 | 21 (11 of them create installs) |
  | `AgentRegistry` | 14 | 11 |
  | `Installable` | 6 | 4 |
  | `InstallableInstallation` | 14 | 3 |
  | `AgentProfile` | 8 | 7 |
  | the bot `User`, via `getOrCreateAgentUser` | 37 calls | 25 |

- **Fixes.** There were about 19 identity and install-path fixes in 90 days, among them #1267, #1734, #1886, #1888, #2165, #2169, #2221, #2254 and #2516.
- **ADR-030 (agent identity) is still a stub.**

**Shape:**

- One service function creates or adopts an agent identity and writes every row it needs.
- Each of its writes creates the row or adopts the one already there. So if a write fails partway, running the function again finishes the identity, and a failed run returns an error, never a success.
- Every install path calls that function.
- A contract test runs each install path and asserts that every row exists afterwards. It also fails one write partway through, then checks that a second run completes the identity.
- That function is the decision ADR-030 is missing.

**Effort:** 3–4 days.

**Moves:**

- files that create installs, from 11 to 1;
- identity and install fixes, from about 6 a month to 1 or fewer.

### 7. A task revision counter and a priority field (2 days)

**Removes:** board races that come from using `updatedAt` as a revision, and rows that wait days to be claimed.

**Evidence:**

- **The revision is `updatedAt`.** `backend/models/Task.ts:27` reads: "The updatedAt revision most recently offered to eligible pod agents."
- **It cost #2561 three HOLDs.** #2561 (own-row board wakes) took 5 HOLDs, and three of them came from `updatedAt` serving as a revision:
  - a retry bumped the revision;
  - a claim raced a PATCH;
  - a rescue reused the revision.
- **Writes are spread out.** There are 14 task write sites in 7 files, and `tasksApi.ts` took 18 fixes among its 29 commits in 90 days.
- **Rows wait.** Created → claimed is 3.2 hours median and 54.3 hours p90. The model has no priority field, so nothing tells a seat which row comes first.

**Shape:**

- An integer `rev`, incremented on every write and used both for CAS and for wake dedupe.
- A `priority` field with four levels, honoured by claim order and by wake preference.

**Effort:** 2 days.

**Moves:**

- board-race HOLDs, to 0;
- created → claimed p90, from 54 hours to under 12.

### 8. Extend the staging smoke's layout checks to the main surfaces (2 days)

**Removes:** layout regressions that a person finds after deploy.

**Evidence:**

- **Fixes.** About 14 layout fixes landed in 90 days (#1079, #1103, #1137, #1179, #1203, #1259, #1383, #1567, #1594, #1603, #1712, #1912, #2046 and #2052). Eight of them were at phone width.
- **`v2.css` churn.** `v2.css` took 66 fix commits among its 146.
- **Many authors.** Of the last 600 merged PRs, 173 touched `frontend/src`. Their branches name at least eight different authors, and 42 of them touched `v2.css`.
- **The trigger has fired.** CLAUDE.md design rule 9 says to stand up a browser-layout tier "when a second person is regularly shipping UI", and that is now true.
- **Coverage today is one route.**
  - The staging smoke checks a single class on it: no horizontal scroll on `/v2` at 1440 and 390 pixels wide (`scripts/staging-smoke/staging-smoke.mjs:90–118`).
  - The Playwright specs under `e2e/` set no viewport.

**Shape:**

- Run the same check at 390 and 1440 on the main surfaces: pod chat, the inspector, Your Team, Connectors and the agent pages.
- Add a no-clip check for names and cards.

**Effort:** 2 days.

**Moves:** layout fixes found after deploy, from about 5 a month to 1.

### 9. Delete unreachable code, and keep it deleted (1 day)

**Removes:** deprecated surfaces that stay reachable, and files that cost agents context while doing nothing.

**Evidence:**

- **The legacy agent manager.** It was still being served on 10-23, until #2505 removed it from the v2 routes.
  - Its 4,715-line `AgentsHub.tsx` is still in the tree.
  - It is exported only by `frontend/src/components/agents/index.ts:1`, a barrel that nothing imports.
- **The frontend.** 17 files are unreachable from `index.tsx`. One is a type declaration (`assets.d.ts`), and the other 16 are product files (8,454 lines).
- **The backend.** 66 files (9,484 lines) are unreachable from `server.ts`, but most of them are not dead:
  - 46 are operator scripts, migrations and seeds, which people run by hand or through `package.json`. Two more are modules that only those scripts import.
  - 4 are config files and type declarations.
  - 8 are one-off scripts at the backend root that no script, workflow or chart runs.
  - 6 are product modules that nothing reaches (1,069 lines). The largest is a WebSocket gateway, `backend/gateway/index.ts` (495 lines), which nothing imports or starts.
- **The CLI.** One file is unreachable from `cli/src/index.js`, and it is live: `cli/src/lib/adapters/pi.js:74` loads `pi-commonly-mcp.mjs` by path. A walk of the imports alone would delete it.

**Shape:**

- First, list every entry point:
  - the two apps and the CLI's `bin`;
  - every file that a `package.json` script, a start script, a workflow or a chart template runs;
  - files loaded by path, like the pi bridge;
  - everything under `backend/scripts/`.
- Delete the product files that nothing on that list reaches: the 16 frontend files and the 6 backend modules. The 8 root scripts go to whoever wrote them, to keep or delete.
- Add a CI check that walks from the same list and fails when a new product file is unreachable. A PR that adds an entry point adds it to the list.

**Effort:** 1 day.

**Moves:** unreachable product lines, from about 9,500 (22 files) to 0, and kept there.

## Do later (each on a trigger)

### A. Split out the worker, then add a job queue (2 days, then 3)

**Removes:** a single API replica that runs everything, and deploys that restart the scheduler.

**Evidence:**

- **One backend replica.** The backend runs one replica (`k8s/helm/commonly/values-dev.yaml:36`). The frontend has run two since the spot outages of 10-19 (`:142`).
- **The API process also runs other work:**
  - 24 cron jobs: 22 in `schedulerService.ts`, plus `agentInstallationCleanupService.ts` and `pgRetentionService.ts`;
  - the hosted agent turns (see B).
- **Only heartbeat dispatch holds a cross-replica lease** (`schedulerService.ts:1064`).
  - Installable cleanup is "deliberately lease-free", because every mutation it makes is a CAS (`:473–477`).
  - The other jobs have not been audited one by one for a second replica.
- **Deploys are frequent.** The last 200 Deploy Dev runs came on 32 days, which is 6.25 per active day, with a peak of 20.
- **Realtime is not the blocker.** Socket.io already fans out through the Redis adapter (`backend/config/socket.ts:76`).
- **The split is already proposed.** #2475 (TASK-355, open) moves the scheduler and the Discord gateway behind `RUN_WORKER`, with an opt-in worker Deployment.

**Trigger:**

1. Wait for item 1, which changes what the scheduler wakes.
2. Then add BullMQ on the Redis we already run.

**Moves:**

- API replicas, from 1 to 2 or more;
- deploys that restart a cron job, to 0.

### B. Move hosted turns into their own Deployment (5–8 days)

**Removes:** hosted turns that die when a deploy restarts the API process.

**Evidence:**

- **Hosted turns run inside the API process** (`dispatchInProcess`, `backend/services/agentEventService.ts:1333`).
- **A restart sweep re-runs turns that died with the process** (`redispatchStuckInProcess`, `agentEventService.ts:919`). It marks each dead turn's run `interrupted` (`:954` and `:1086`, the only places that write that status).
- **ADR-021 (Accepted) already specifies the target**, a separate `agent-runtime` Deployment. The chart has none yet.

**Trigger:**

- Wait until A is done.
- Wait for a count of turns interrupted per deploy, which needs a database read (the query is in *How to re-measure*). If most deploys interrupt hosted turns, this moves up behind A.

**Moves:** hosted turns interrupted per deploy, from the count that query returns to 0.

### C. Store chat messages only in PostgreSQL (2–3 days)

**Removes:** faults that come from a second message store, like the double posts in #759 and the second copy in #2543.

**Evidence:**

- **Two stores.** Messages live in PostgreSQL, with a MongoDB fallback:
  - fallback branches sit in 7 files, led by `server.ts` (7), the message controller (3) and `agentMessageService.ts` (2);
  - `pg/Message.ts` took 12 fixes in 90 days.
- **The fallback has caused faults:**
  - in #759 (07-26), messages read through the MongoDB fallback carried no `isBot`, so the check for another agent's post never fired, and agents double-posted whenever PostgreSQL was unavailable;
  - in #2543 (TASK-313, 10-23), an error after the PostgreSQL insert made the controller fall back and store a second copy in MongoDB. A fallback row cannot carry a reply edge.
- **Product code creates a MongoDB message only as a fallback** (`messageController.ts:343`, `server.ts:681` and `:716`, `agentMessageService.ts:1806`), and no script creates one. So any row created there recently is a fallback that fired.

**Trigger:** a count of MongoDB message rows written in the last 30 days (the query is in *How to re-measure*). If there are any, this moves to Do now.

**Moves:** message stores, from two to one, and files with a MongoDB message fallback, from 7 to 0.

### D. Remove OpenClaw, per ADR-021 Phases 3–4 (3–5 days, plus 1 for docs)

**Removes:** code and agent context that a parked runtime still costs.

**Evidence:**

- **Parked since 08-20.** `values-dev.yaml:212–225` sets it to `enabled: false`.
- **Cheap to maintain.** It has had 10 commits since the park, 3 of them fixes, spread across the provisioner, the presets, the tool-contract script and the submodule.
- **Expensive to read:**
  - 56 backend product files mention it;
  - CLAUDE.md carries 37 lines about it;
  - CLAUDE.md is read on every spawn. It is now 68,794 bytes (about 17k tokens), up 44% in 90 days.

**Trigger:** ADR-021's own: "Phase 2 complete + no moltbot posted in 14 days". Phase 4 then moves the CLAUDE.md rules to `docs/agents/legacy-openclaw.md`.

**Moves:** CLAUDE.md, to under 45 KB.

### E. Split `v2.css` (2 days)

**Removes:** merge conflicts in one 13,160-line stylesheet, if a count shows them.

**Evidence:**

- 13,160 lines;
- 146 commits in 90 days, 66 of them fixes;
- 42 of the last 600 merged PRs;
- no count of merge conflicts exists yet.

**Trigger:** after item 8, if a conflict count shows more than two `v2.css` conflicts a week.

**Moves:** `v2.css` merge conflicts, from that weekly count to under one a week.

### F. Retire the legacy ChatRoom (2–3 days)

**Removes:** a second chat implementation that fixes have to reach.

**Evidence:**

- **Still in use.** `ChatRoom.tsx` (4,962 lines) still serves Pod Tools. It is lazy-loaded at `frontend/src/v2/V2App.tsx:44` and rendered at `:254`.
- **Cheap to keep.** It took 4 fixes in 90 days.

**Trigger:** Pod Tools gets a v2 home.

**Moves:** chat implementations, from two to one, which removes 4,962 lines.

## Don't

| Don't | The number that says leave it alone | Revisit if |
|---|---|---|
| Rewrite in another language | The measured costs are wakes, gates and turn length. A *keyword* search of the 577 fix subjects in 90 days finds none about speed, CPU, memory use or timeouts. Item 3's turn timeouts are long agent turns, not slow code. | a profile shows a CPU-bound path that users feel |
| Split into microservices | Tonight's incidents were one fact kept in several places, and more services multiply the places. Two process splits (A, B) cover the deploy-coupling cost. | one part needs its own release cadence |
| Speed up CI | Queue time is 0. Successful runs take 4.2 minutes median and 9.4 minutes p90. Superseding pushes cancel 39% of runs (`cancel-in-progress`, `.github/workflows/tests.yml:48`), which costs runner time and nobody's wait. A slow PR waits hours, not minutes (item 2). | queue time appears |
| Port the CLI or the MCP server to TypeScript | `agent.js` took 26 fixes in 90 days, and none names a type error. They were semantics, which is item 1. | a type-class bug turns up |
| Burn down backend `.js` lint as a project | It has 2,279 errors, and 277 of the 282 dirty files are under `__tests__` (measured 08-28). The `.ts` gate already catches new violations. | never as a project; fix files as they are touched |
| Build a design-token pipeline | `tokens.css` (118 variables) and `v2.css` (86) share only 7 names, all motion, and those agree, so there is no drift to automate. Instead, fix the CLAUDE.md line that says the two "must move together". | the two files start sharing colour tokens |
| Replace auth or Socket.io | No incident in the window points at either. The Redis adapter needed to scale out is already wired. | an incident points at one |
| Adopt a hosted workflow engine | BullMQ on the Redis we already run covers the queue in A. | A outgrows BullMQ |
| Do more LLM-gateway work | LiteLLM saw 0 real 429s in about 727 requests. The fleet's limit hits (41 in 48 hours, peaking at 23 in one hour) are provider session limits on seats that call their providers directly, which gateway work does not touch. | 429s appear at the gateway |
| Move other collections to PostgreSQL | No incident outside messages traced back to the store. | an incident does |
| Switch to ADR-001's Phase 3 read path | It is paused under ADR-011, and no drift bug showed up in the window. | ADR-011's trigger fires |

## Tonight's incidents, mapped

| Incident | Item |
|---|---|
| A self-serve install for a local agent wrote no registry row, so the agent was "not found" (#2516). | 6 |
| A credential retirement did not reach everywhere it needed to (#2521). | 5 |
| Revoked keys still showed as connected (#2560, plus three follow-up rows). | 5 |
| The deprecated agent manager was still being served (#2505). | 9 |
| A skills directory resolved on one host only (fixed 10-23). | 1 (settings match what runs) |
| Staging pointed at production URLs (#2529, #2481, #2568). | 4 |

## By area

| Area | Verdict | Items |
|---|---|---|
| Language | Keep TypeScript in the backend and frontend, and JavaScript in the CLI and the MCP server. | Don't |
| Stack | Keep Express, MongoDB, PostgreSQL, Redis and Socket.io. Add BullMQ on Redis after the worker split. | A, Don't |
| System design | A modular monolith with two process splits: a worker, then the agent runtime. | A, B |
| Structure | One place per fact. Delete what nothing reaches. | 4, 5, 6, 9 |
| Data model | Credentials in one collection, one identity writer, and a task `rev` and `priority`. Messages move to one store once the fallback rows are counted. | 5, 6, 7, C |
| Test strategy | The backend already has more test lines than product lines (131k against 126k, leaving out operator scripts). The window's misses were cross-store and layout bugs that unit tests don't reach, so add contract tests and layout checks, not more unit tests. | 6, 8 |
| UI | Layout checks come first. Split `v2.css` and retire ChatRoom only when their triggers fire. | 8, E, F |
| Agent context | CLAUDE.md is read on every spawn and grew 44% in 90 days. The OpenClaw sweep is its biggest cut. | D |

## Commonly in 6 months (April 2027)

The languages, databases and frameworks stay the same. Two things change: each fact lives in one place, and an agent wakes only when it is addressed.

- **Three processes.**
  - The API runs two or more replicas.
  - A worker owns cron and the job queue (BullMQ on Redis).
  - The agent runtime runs hosted turns, per ADR-021.
  - A deploy restarts no cron job and interrupts no hosted turn.
- **One place per fact.** There is one instance-URL module, one credential collection, one identity-creation function and one task revision counter. A revoke reaches everything, because there is only one place to reach.
- **Addressed wakes.** A seat wakes on a mention, its own row, its own thread, or its own task or PR. Everything else arrives as a digest, and most turns do something.
- **Gates on the PR.** Every gate ask, HOLD and PASS reaches whoever acts next without anyone relaying it, and the p90 from opened to merged is under four hours.
- **Layout-checked UI.** Every UI change is checked at phone and desktop width before it deploys.
- **A smaller CLAUDE.md.** OpenClaw is gone, if ADR-021's trigger fires, and CLAUDE.md is under 45 KB.

Re-measure these numbers monthly:

| Number | Oct 2026 | Apr 2027 target | Item |
|---|---|---|---|
| Turns that post nothing (48 h) | 86% | under 40% | 1 |
| Spawns per hour, daily average | 405 (baseline) | at least 60% lower | 1 |
| PR opened → merged, p90, read a week after the window | 10.7 h so far; at least 14.7 h once the open ones merge | under 4 h | 2 |
| Turn timeouts per 48 h | 71 | under 15 | 3 |
| Instance-URL incidents | 3 in two days | 0 per quarter | 4 |
| Revoke-missed-a-store fixes | 5 in six weeks | 0 per quarter | 5 |
| Identity and install fixes (90 d) | about 19 | 3 or fewer | 6 |
| Row created → claimed, p90 | 54.3 h | under 12 h | 7 |
| Layout fixes found after deploy (90 d) | about 14 | 3 or fewer | 8 |
| Unreachable product lines | about 9,500 | 0 | 9 |
| API replicas | 1 | 2 or more | A |
| CLAUDE.md size | 68.8 KB | under 45 KB | D |
| Fix share of commits (90 d) | 39% | under 25% | all |

## Still open

- **The row's notes.** This report works from tonight's incident list, as given with TASK-438. It has not yet been checked against the row's own notes. Any incident they add gets a line in *Tonight's incidents, mapped*.
- **Two database counts.** Both queries are in *How to re-measure*.
  - MongoDB message rows created in the last 30 days decide whether C moves to Do now.
  - Turns interrupted per deploy decide how soon B moves.
- **The efforts are estimates**, made by counting the sites each item touches. Re-estimate each one with the implementor who takes it.
- **The PR figures are provisional until 2026-10-30.** Item 2's p90 is read a week after the window, once the PRs still open have merged or closed.

## How to re-measure

These blocks reproduce the monthly table and the main evidence. To re-measure, swap in a new ref, window or date. The few numbers they don't cover were counted by hand from the same data.

### Git history

```sh
REF=0afed7ba1 SINCE=2026-07-26T00:00:00Z
git log $REF --no-merges --since=$SINCE --format=%s > subjects.txt
wc -l < subjects.txt                       # commits: 1,484
grep -ciE '^fix' subjects.txt              # fixes: 577, which is 39% of commits
grep -iE '^fix' subjects.txt | grep -ciE 'token|credential|revoke|auth|401|403'   # 73
grep -iE '^fix' subjects.txt \
  | grep -ciwE 'slow|slower|latency|perf|performance|cpu|oom|heap|timeout|timeouts|timed|speed'   # 0
git log $REF --no-merges --since=$SINCE --format='>%s' --name-only \
  | awk '/^>/ { fix = (tolower(substr($0, 2, 3)) == "fix"); next } fix && NF' \
  | sort | uniq -c | sort -rn | head        # fix commits per file
git log $REF --no-merges --since=$SINCE --format= --name-only \
  | sed '/^$/d' | sort | uniq -c | sort -rn | head   # all commits per file
git show $REF:CLAUDE.md | wc -c            # 68,794 bytes
```

The speed search leaves out `memory` and `leak`. In these fix subjects, those words match only fixes to agent memory and to data leaks, not to memory use.

### PR timelines

```sh
gh pr list --repo Team-Commonly/commonly --state all --limit 300 \
  --search "created:2026-10-21T22:30:00Z..2026-10-23T22:45:00Z" \
  --json number,state,isDraft,createdAt,mergedAt,reviews,body > window.json
jq -r --arg now 2026-10-24T05:12:00Z '
  def q($a; $p): ($a | length - 1) as $n | ($n * $p | floor) as $lo | ([$lo + 1, $n] | min) as $hi
    | ($a[$lo] + ($a[$hi] - $a[$lo]) * ($n * $p - $lo)) * 10 | round / 10;
  def hours($a; $b): (($b | fromdate) - ($a | fromdate)) / 3600;
  ([.[] | select(.mergedAt) | hours(.createdAt; .mergedAt)] | sort) as $m
  | ([.[] | select(.mergedAt and .mergedAt <= "2026-10-23T22:45:00Z") | hours(.createdAt; .mergedAt)] | sort) as $c
  | [.[] | select(.state == "OPEN" and (.isDraft | not)) | hours(.createdAt; $now)] as $o
  | "at the cutoff: \($c | length) merged, median \(q($c; .5)) h, p90 \(q($c; .9)) h",
    "at \($now): \($m | length) merged, median \(q($m; .5)) h, p90 \(q($m; .9)) h",
    "counting the \($o | length) open non-draft PRs at their age: p90 at least \(q($m + $o | sort; .9)) h"' window.json
jq -r '"bodies naming a gate: \(map(select((.body // "") | test("(?m)^\\W*gates?\\b"; "i"))) | length) of \(length)"' window.json
mkdir timelines
for n in $(jq -r '.[] | select(.mergedAt or (.state == "OPEN" and (.isDraft | not))) | .number' window.json); do
  gh api "repos/Team-Commonly/commonly/issues/$n/timeline?per_page=100" > timelines/$n.json
done
python3 -I waits.py window.json timelines 2026-10-24T05:12:00Z
gh api repos/Team-Commonly/commonly/rules/branches/main --jq '.[].type'   # includes merge_queue
```

Read at 05:12Z, the first `jq` printed 86 merged at the cutoff (61 minutes median, 7.2 hours p90), 107 merged by 05:12Z (1.9 and 10.7 hours), and a p90 of at least 14.7 hours once the 13 open PRs are counted. The second printed 32 of 150.

`waits.py` labels each stretch of a PR's open time by what the PR was waiting on, and sums the labels. Push times come from commit dates and force-push events, so a commit pushed long after it was made reads as pushed early. A fresh list also counts PRs that merged after 05:12Z, so the shares move until every PR in the window has closed.

<details>
<summary><code>waits.py</code></summary>

```python
# python3 -I waits.py window.json timelines/ 2026-10-24T05:12:00Z
import json, os, re, sys
from datetime import datetime

win, tdir, now = sys.argv[1], sys.argv[2], sys.argv[3]
t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
GATE = re.compile(r'^\W*GATE\s*:?\W*(PASS|HOLD)', re.I)

def verdict(body):
    lines = [l for l in (body or '').splitlines() if l.strip()]
    m = GATE.match(lines[-1]) if lines else None
    return m.group(1).upper() if m else None

def events(n):
    out, born_draft = [], None
    for e in json.load(open(os.path.join(tdir, f'{n}.json'))):
        k = e.get('event')
        if k == 'committed':
            out.append((t(e['committer']['date']), 'push'))
        elif k == 'head_ref_force_pushed':
            out.append((t(e['created_at']), 'push'))
        elif k == 'reviewed' and e.get('submitted_at') and verdict(e.get('body')):
            out.append((t(e['submitted_at']), verdict(e['body'])))
        elif k in ('ready_for_review', 'convert_to_draft', 'added_to_merge_queue', 'removed_from_merge_queue'):
            out.append((t(e['created_at']), k))
            if born_draft is None and k in ('ready_for_review', 'convert_to_draft'):
                born_draft = k == 'ready_for_review'
    return sorted(out), bool(born_draft)

def split(p, end):
    # What the PR waits on: a 'gate' until a verdict, its 'author' from a HOLD
    # until a push, a merge ('cleared') from a PASS until queued or pushed, and
    # the 'queue' while queued. Draft time is counted apart.
    start = t(p['createdAt'])
    ev, draft = events(p['number'])
    passed, state, last, since = False, 'gate', start, start
    acc, gate_waits, clear_waits, passes = {}, [], [], 0
    for ts, k in [e for e in ev if start < e[0] < end] + [(end, None)]:
        label = ('draft, cleared' if passed else 'draft') if draft else state
        acc[label] = acc.get(label, 0) + (ts - last).total_seconds() / 3600
        last, before = ts, (state, draft)
        if k in ('PASS', 'HOLD') and state == 'gate' and not draft:
            gate_waits.append((ts - since).total_seconds() / 3600)
        if k == 'added_to_merge_queue' and state == 'cleared' and not draft:
            clear_waits.append((ts - since).total_seconds() / 3600)
        if k == 'push': passed, state = False, 'gate'
        elif k == 'HOLD': passed, state = False, 'author'
        elif k == 'PASS': passed, state = True, ('queue' if state == 'queue' else 'cleared')
        elif k == 'added_to_merge_queue': state, passes = 'queue', passes + 1
        elif k == 'removed_from_merge_queue': state = 'cleared' if passed else 'gate'
        elif k == 'convert_to_draft': draft = True
        elif k == 'ready_for_review':
            draft = False
            if state != 'queue':
                state = 'cleared' if passed else ('author' if state == 'author' else 'gate')
        if (state, draft) != before:
            since = ts
    now_label = ('draft, cleared' if passed else 'draft') if draft else state
    return acc, now_label, gate_waits, clear_waits, passes

def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; lo = int(k); hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)

def show(name, rows):
    tot = {}
    for r in rows:
        for k, v in r[0].items():
            tot[k] = tot.get(k, 0) + v
    T = sum(tot.values())
    print(f'{name}: {len(rows)} PRs, {T:.1f} h')
    for k, v in sorted(tot.items(), key=lambda x: -x[1]):
        print(f'  {k:15} {v:6.1f} h {100 * v / T:3.0f}%')

prs = json.load(open(win))
merged = sorted((p for p in prs if p['mergedAt']), key=lambda p: t(p['mergedAt']) - t(p['createdAt']), reverse=True)
rows = [split(p, t(p['mergedAt'])) for p in merged]
show('slowest tenth', rows[:-(-len(rows) // 10)])
show('all merged', rows)
for name, i in (('waits for a gate verdict', 2), ('waits from a PASS to the queue', 3)):
    w = [x for r in rows for x in r[i]]
    print(f'{name}: {len(w)}, median {60 * pct(w, .5):.0f} min, p90 {pct(w, .9):.1f} h, over 4 h {sum(x > 4 for x in w)}')
print('queue passes', sum(r[4] for r in rows), 'for', len(rows), 'merges')
waiting = [split(p, t(now))[1] for p in prs if p['state'] == 'OPEN' and not p['isDraft']]
print('open, not draft, now waiting on:', {s: waiting.count(s) for s in sorted(set(waiting))})
```

</details>

### Workflow runs and merged PRs

```sh
gh run list --repo Team-Commonly/commonly --workflow=deploy-dev.yml -L 200 --json createdAt \
  --jq 'group_by(.createdAt[0:10]) | map(length) | "runs \(add), active days \(length), per active day \(add / length), peak \(max)"'
# runs 200, active days 32, per active day 6.25, peak 20
gh run list --repo Team-Commonly/commonly --workflow=tests.yml -L 400 \
  --json createdAt,startedAt,updatedAt,conclusion > tests-runs.json
jq -r '
  def q($a; $p): ($a | length - 1) as $n | ($n * $p | floor) as $lo | ([$lo + 1, $n] | min) as $hi
    | $a[$lo] + ($a[$hi] - $a[$lo]) * ($n * $p - $lo);
  def secs($a; $b): ($b | fromdate) - ($a | fromdate);
  ([.[] | secs(.createdAt; .startedAt)] | sort) as $wait
  | ([.[] | select(.conclusion == "success") | secs(.startedAt; .updatedAt) / 60] | sort) as $ok
  | "queue: median \(q($wait; .5)) s, p90 \(q($wait; .9)) s",
    "success: \($ok | length) runs, median \(q($ok; .5) * 10 | round / 10) min, p90 \(q($ok; .9) * 10 | round / 10) min",
    "cancelled: \(map(select(.conclusion == "cancelled")) | length) of \(length)"' tests-runs.json
# queue 0 s; 217 successful runs, 4.2 min median, 9.4 min p90; 156 of 400 cancelled
gh pr list --repo Team-Commonly/commonly --state merged --limit 600 \
  --json number,headRefName,files > merged.json
jq -r '[.[] | select(any(.files[]; .path | startswith("frontend/src/")))] as $f
  | "frontend: \($f | length), v2.css: \([$f[] | select(any(.files[]; .path | endswith("/v2.css")))] | length)",
    ($f | map(.headRefName | split("/")[0]) | group_by(.) | map("\(.[0]) \(length)") | join(", "))' merged.json
# frontend: 173, v2.css: 42, then the branch prefixes, which name the authors
```

### Reachability

```sh
python3 -I reach.py <checkout>/frontend/src index.tsx   # 17 unreachable, 8,478 lines
python3 -I reach.py <checkout>/backend server.ts        # 66 unreachable, 9,484 lines
python3 -I reach.py <checkout>/cli/src index.js         # 1 unreachable, loaded by path
```

The walk follows relative `import`, `import()`, `require` and `export … from`. Neither `tsconfig.json` sets `baseUrl` or `paths`, so relative resolution is enough. It cannot see files loaded by path, config files or type declarations, which is why item 9 lists the entry points first.

<details>
<summary><code>reach.py</code></summary>

```python
import os, re, sys
root = sys.argv[1]
entries = sys.argv[2:]
exts = ['.tsx', '.ts', '.jsx', '.js', '.mjs']
imp = re.compile(r"""(?:import\s+(?:[^'"]*?\s+from\s+)?|import\(\s*|require\(\s*|export\s+[^'"]*?\s+from\s+)['"]([^'"]+)['"]""")
def resolve(base, spec):
    if not spec.startswith('.'):
        return None
    p = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    cands = [p] + [p + e for e in exts] + [os.path.join(p, 'index' + e) for e in exts]
    for c in cands:
        if os.path.isfile(c):
            return c
    return None
def is_test(p):
    return '__tests__' in p or '.test.' in p or '__mocks__' in p or 'setupTests' in p
allf = []
for d, _, fs in os.walk(root):
    if {'node_modules', 'dist'} & set(d.split(os.sep)):
        continue
    for f in fs:
        if os.path.splitext(f)[1] in exts:
            allf.append(os.path.join(d, f))
seen = set()
stack = [os.path.join(root, e) for e in entries]
while stack:
    f = stack.pop()
    if f in seen: continue
    seen.add(f)
    try:
        src = open(f, encoding='utf-8', errors='ignore').read()
    except Exception:
        continue
    for m in imp.finditer(src):
        r = resolve(f, m.group(1))
        if r and r not in seen:
            stack.append(r)
unreach = [f for f in allf if f not in seen and not is_test(f)]
tot = 0; rows = []
for f in unreach:
    n = sum(1 for _ in open(f, encoding='utf-8', errors='ignore'))
    tot += n; rows.append((n, os.path.relpath(f, root)))
rows.sort(reverse=True)
print('reachable files', len(seen), 'non-test files', len([f for f in allf if not is_test(f)]))
print('unreachable non-test files', len(unreach), 'lines', tot)
for n, f in rows:
    print(n, f)
```

</details>

### Stylesheets and test lines

```sh
python3 -I - frontend/design-system/tokens.css frontend/src/v2/v2.css <<'EOF'
import re, sys
pat = re.compile(r'(?<![\w-])(--[\w-]+)\s*:')   # the lookbehind skips BEM modifiers like item--active
s = [set(pat.findall(re.sub(r'/\*.*?\*/', '', open(f).read(), flags=re.S))) for f in sys.argv[1:]]
print(len(s[0]), len(s[1]), sorted(s[0] & s[1]))
EOF
# 118 86, then the 7 shared names, all --motion-*
cd backend && python3 -I - <<'EOF'
import os
n = {'test': 0, 'script': 0, 'product': 0}
for d, _, fs in os.walk('.'):
    parts = set(d.split(os.sep))
    if parts & {'node_modules', 'dist', 'coverage'}:
        continue
    for f in fs:
        if os.path.splitext(f)[1] in {'.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'}:
            p = os.path.join(d, f)
            k = ('test' if '__tests__' in p or '.test.' in f or '__mocks__' in p
                 else 'script' if parts & {'scripts', 'migrations', 'seed'} else 'product')
            n[k] += sum(1 for _ in open(p, errors='ignore'))
print(n)
EOF
# test 131,346, script 7,322, product 125,615
```

### Database

```js
// C: chat messages created in MongoDB in the last 30 days. Product code creates them only
// as a fallback (messageController.ts:343, server.ts:681 and :716, agentMessageService.ts:1806).
db.messages.countDocuments({ createdAt: { $gte: new Date(Date.now() - 30 * 864e5) } })

// B: turns the restart sweep marked interrupted, per day. agentEventService.ts:954 and :1086
// are the only writers of that status. Compare with Deploy Dev runs per day.
db.agentruns.aggregate([
  { $match: { status: 'interrupted', completedAt: { $gte: new Date(Date.now() - 30 * 864e5) } } },
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } },
])

// Item 7: row created -> first claim, in hours. claimedAt keeps only the latest claim, but every
// claim appends a "Claimed by ..." update (tasksApi.ts:585), so take the earliest of those.
// Rows never claimed are left out, so this reads low.
const h = db.tasks.aggregate([
  { $match: { createdAt: { $gte: ISODate('2026-10-21T22:30:00Z'), $lt: ISODate('2026-10-23T22:45:00Z') } } },
  { $project: { createdAt: 1, first: { $min: { $map: {
    input: { $filter: { input: '$updates', cond: { $regexMatch: { input: '$$this.text', regex: /^Claimed by / } } } },
    in: '$$this.createdAt' } } } } },
  { $match: { first: { $ne: null } } },
  { $project: { _id: 0, hours: { $divide: [{ $subtract: ['$first', '$createdAt'] }, 3600000] } } },
  { $sort: { hours: 1 } },
]).toArray().map((d) => d.hours);
const q = (p) => { const k = (h.length - 1) * p, lo = Math.floor(k), hi = Math.min(lo + 1, h.length - 1); return h[lo] + (h[hi] - h[lo]) * (k - lo); };
print(h.length, q(0.5), q(0.9));
```

Item 7's 3.2 and 54.3 hours come from the SRE report. This query takes the same figure from the board directly.

### Everything else

- **Fleet logs.** Turns, spawns, wakes, timeouts and LiteLLM status codes come from the internal SRE report, which is built from each seat's runtime log. Only the operator can read those logs, so ask for the same report each month.
- **Counted by hand.** Instance-URL incidents, revoke-missed-a-store fixes, identity and install fixes, and layout fixes were counted by reading fix subjects and their PRs. Items 4, 5, 6 and 8 list the PR numbers. Keep listing them each month, so the next count can be checked against this one.
- **API replicas.** The backend's `replicaCount`, at `k8s/helm/commonly/values-dev.yaml:36`.
