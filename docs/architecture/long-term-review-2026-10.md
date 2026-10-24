# Long-term review: what to refactor, and what to leave alone (2026-10)

**Status:** Full report. The row's notes and two database counts are still open (see *Still open*). Anything that arrives by 2026-10-25 01:00Z lands on this same PR, so don't merge before then.
**Asked by:** the CTO (TASK-438).
**Measured at:** `main` `0b22729fa` (2026-10-24 03:59Z) and GitHub as of 2026-10-24 05:12Z, unless a line says otherwise.

## The rule

Refactor only with numbers. Each item below names three things:

- the failure it removes, with the incident, PR or measured cost behind it;
- the effort, in implementor-days, including the usual two review rounds;
- the number that should move once it ships.

An idea with no number behind it goes under **Don't**, along with the condition that would change that.

## The finding

1. **The largest measured costs are in the pipeline, not in the code.** In 48 hours, 86% of agent turns posted nothing. A slow PR spends its time waiting. In the slowest tenth of merged PRs, 28% of the open time waited for a gate verdict, 23% fell inside a recorded merge freeze, and 21% came after every gate on record had passed the PR's head and its checks were green, before anyone queued it. The PR rarely records why it waited. The author answering a HOLD took 3%.
2. **Most of tonight's incidents, and most of the 90-day fix hotspots, are one fact kept in several places.** Credentials live in three stores. Two URLs are read under four environment names. Agent identity is written from 11 places. The task revision is `updatedAt`.
3. **The usual rewrite candidates have numbers that say to leave them alone.** That covers the language, microservices, CI speed, a token pipeline, auth and Socket.io.

## Sources

- **Git history.** `main` at `0afed7ba1`, from 2026-07-26 00:00Z (90 days): 1,484 non-merge commits, 39% of them typed `fix`.
- **GitHub lists, each capped by the API:**
  - the last 600 merged PRs, created 2026-09-23 to 10-24 and read at 10-24 05:53Z;
  - the last 200 Deploy Dev runs (09-04 to 10-24);
  - the last 400 Tests runs (10-23 15:32Z to 10-24 05:08Z).
- **PR timelines** for the 150 PRs opened in the 48 hours to 2026-10-23 22:45Z, read from GitHub at 10-24 06:39–06:42Z and counted up to 05:12Z. Each PR's full timeline (every page) gives when it was opened, pushed, marked ready, gated, queued and merged, and the Tests runs give each head commit and its result. A gate verdict is a review whose last line is `GATE: PASS`, `GATE: HOLD` or `GATE: FAIL` and nothing more, and it belongs to the gate its byline names.
- **Fleet logs** for 10-21 22:30Z to 10-23 22:45Z, from an internal SRE report. They give turns, wakes, timeouts, failures and LiteLLM status codes. The same report gives the row created → claimed times.
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

### 2. Checkpoint before the turn cap, and slice rows to fit (1 day)

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

### 3. One source for the instance URL (1 day)

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

### 4. Record on the PR what it waits on, and list what can merge (1 day)

**Removes:** waits that the PR does not explain. A PR that every gate has passed and that is held on purpose looks the same as one that nobody has queued, and most PR bodies don't name the gates they wait for.

**Evidence** (the 150 PRs opened in the 48 hours to 10-23 22:45Z):

- **The interim's p90 was too low.** At the window's end, opened → merged measured 61 minutes median and 7.2 hours p90. That counted only the PRs that had already merged. By 10-24 05:12Z, 107 had merged, at 1.9 hours median and 10.7 hours p90. If the 13 non-draft PRs still open then also merge, the p90 across those 120 will be at least 14.7 hours.
- **The time goes to waiting, not to fixing.** `waits.py` (in *How to re-measure*) labels each stretch of a PR's open time by what its record shows:

  | Open time spent | Slowest tenth (11 PRs, 209 h) | All 107 merged (449 h) |
  |---|---|---|
  | waiting for a gate verdict on the current head | 28% | 25% |
  | inside the recorded freeze, on a PR that changes a frozen path | 23% | 11% |
  | with every gate on record passed at the head and checks green, not yet queued | 21% | 29% |
  | as a draft | 15% | 19% |
  | as a draft, with every gate on record passed at the head | 8% | 9% |
  | with a HOLD standing at the current head | 3% | 3% |
  | in CI, or in the merge queue | 2% | 4% |

- **The third row is an upper bound.** A gate is on record once it posts a verdict on the PR, or once the body names it on a `Gate:` line, and only 32 of the 150 bodies have that line. So the third row also holds PRs whose last gate was asked only in chat and had not answered, and PRs held on purpose without saying so. The record cannot tell those apart from PRs that nobody queued.
- **This corrects the earlier draft.** It put 45% of the slowest tenth's open time on PRs that had passed and that nobody had queued. Its classifier let any PASS clear the PR: it ignored which head the PASS was for, let one gate's PASS clear another gate's HOLD, counted time inside the freeze, and read only the first page of each timeline. With those fixed, the share is 21%, and the freeze is 23%.
- **A few long waits make the tail.** The median wait for a gate verdict was 9 minutes. Once every gate on record had passed and checks were green, the median wait to be queued was 1 minute. But 5 waits for a verdict ran past 4 hours, and so did 11 waits to be queued. Of those 11, the PR records a reason for 4: two ran into the freeze and were queued within three minutes of its end, one body says it is not urgent, and one comment times the merge to a deploy. The other 7 record nothing, and 6 of those were queued in the same half hour as the one timed to a deploy.
- **Passed PRs sit open.** At 05:12Z, 13 PRs in the window were open and not drafts. On 10 of them, every gate on record had passed the head and its checks were green. At the window's end it was 26 of 32.
- **The merge queue is not the wait.** `main` merges through a GitHub merge queue, and the Tests workflow runs on it (`.github/workflows/tests.yml:18`). The 107 merges took 116 passes through the queue, so 9 times a PR left the queue and was queued again. The queue took 3% of all open time.

**Shape:**

- **Record the wait on the PR.** The body names every gate on one `Gate:` line. A PR held on purpose is a draft, or carries a `Hold:` line with the reason and when it ends. A freeze is written down once, as paths and a window, where the list reads it.
- **One list, from the PR timelines.** It shows each open PR as ready (oldest first), held and why, or waiting on which gate and since when. Ready means that every gate on the `Gate:` line, and every gate that has reviewed, has passed the current head, that its checks there are green, and that no `Hold:` line or freeze applies. A PASS from one gate never stands in for another gate's verdict, and a PASS on an older head counts for nothing. The list reads verdicts the way `waits.py` does, from the review's last line, but only from the accounts the gates review from, and credits each to the gate its byline names. The work is to turn `waits.py` into that list and run it on a schedule where whoever merges reads it.
- **Route events second, if the trigger fires.** Build on the GitHub App receiver. It already verifies review events (`backend/routes/webhooks/github.ts:56`) and posts cards into a bound pod (`backend/services/githubGigService.ts`). It is off by default, and each instance switches it on (`k8s/helm/commonly/values.yaml:282`). Read only a review's last line, and copy nothing else from the review, which keeps the rule at `githubGigService.ts:60–61`. On a HOLD, tell the author. When a PR becomes ready, tell whoever merges. On a push after a verdict, tell each gate whose verdict the push made stale.

**Trigger** (for the routing): run the list for two weeks. If waits over 4 hours for a gate verdict, or waits over 4 hours to be queued with no recorded reason, still happen more than once a week, add the routing.

**Effort:** 1 day for the `Gate:` and `Hold:` lines and the list. The routing is 2 more days, on its trigger. The receiver, the signature check and delivery dedupe exist.

**Moves:**

- PR bodies with a `Gate:` line, from 21% to over 90%;
- waits over 4 hours to be queued with no recorded reason, from 7 in the window to 0;
- waits over 4 hours for a gate verdict, from 5 in the window to under one a week;
- opened → merged p90, read a week after the window closes, from at least 14.7 hours to under 4 within six months.

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

**Removes:** hosted turns that die whenever the API process stops, for a rollout or a crash.

**Evidence:**

- **Hosted turns run inside the API process** (`dispatchInProcess`, `backend/services/agentEventService.ts:1333`).
- **Nothing lets them finish at shutdown.** A rollout gives the old pod a 10-second `preStop` sleep (`k8s/helm/commonly/templates/core/backend-deployment.yaml:659–661`) inside a 30-second grace period (`:28`), and SIGTERM comes after the sleep. No backend module handles that signal (see *Everything else*), so the process is gone within those 30 seconds, whatever turns it is running. A native turn can take up to about two minutes (`agentEventService.ts:1077`).
- **A sweep marks the stale rows later.** `garbageCollect` (`agentEventService.ts:723`) runs every 10 minutes (`schedulerService.ts:182–186`), and once 8 seconds after the scheduler starts (`:644–648`). It re-runs a turn whose event was left delivered and stale (`redispatchStuckInProcess`, `agentEventService.ts:919`), and gives up on runs left queued or running past a cutoff (`interruptAbandonedRuns`, `:1081`). Both mark the run `interrupted` (`:952–955` and `:1084–1086`, the only writers of that status), and both set `completedAt` to the time of the sweep, not the time the turn stopped.
- **So the daily count is of rows the sweep marked `interrupted`, not of deploys, and not only of turns that died.** Both writers judge a turn by its row's stored status, and a turn can finish yet leave its row `running`. The row is saved as `running` when the turn starts (`backend/services/nativeRuntimeService.ts:1792–1793`); if the final save fails, the failure is logged and swallowed (`:2234–2239`), and the turn still returns its result (`:2253–2255`). Nor can a daily count say which restart a row belongs to: ten such rows on a day with ten deploys fit one per deploy, all ten at one deploy, or a crash between them. The join in *How to re-measure* pairs a row with a restart only when exactly one backend restart falls between its `startedAt` and its `completedAt`, and counts the rest apart. Each pair is a candidate that needs confirming, not a cause: a restart that comes after a lost final save pairs the same way. Operator evidence that the turn or its process was still running at that shutdown, or an equivalent check that rules out a lost final write, promotes a candidate. Until one is promoted, which restarts ended which turns stays unresolved. The join also needs the restart times, which only the operator can read.
- **ADR-021 (Accepted) already specifies the target**, a separate `agent-runtime` Deployment. The chart has none yet.

**A cheaper first step:** drain before exit. On SIGTERM, stop starting turns, let the ones in flight finish, and set the grace period past the turn bound. That covers rollouts and other graceful stops, not crashes, and it is about a day.

**Trigger:** a confirmed restart-caused loss: a hosted turn that operator evidence shows was still running when a backend restart ended it. The join in *How to re-measure* finds candidates. It does not settle the question alone and gives B no baseline. If a confirmed loss came at a rollout, do the drain now; it does not wait for A. If one came at a crash, B itself moves up, right behind A.

**Moves:** hosted turns confirmed as ended by a backend restart, to 0, rollouts first through the drain. The baseline is the confirmed count, not the join's candidates, and it stays unmeasured until a candidate is confirmed.

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
| Rewrite in another language | The measured costs are wakes, PR waits and turn length. A *keyword* search of the 577 fix subjects in 90 days finds none about speed, CPU or timeouts, and the 3 that mention memory or a leak are about agent memory and a data leak, not memory use. Item 2's turn timeouts are long agent turns, not slow code. | a profile shows a CPU-bound path that users feel |
| Split into microservices | Tonight's incidents were one fact kept in several places, and more services multiply the places. Two process splits (A, B) cover the deploy-coupling cost. | one part needs its own release cadence |
| Speed up CI | Queue time is 0. Successful runs take 4.2 minutes median and 9.4 minutes p90. Superseding pushes cancel 39% of runs (`cancel-in-progress`, `.github/workflows/tests.yml:48`), which costs runner time and nobody's wait. A slow PR waits hours, not minutes (item 4). | queue time appears |
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
| Staging pointed at production URLs (#2529, #2481, #2568). | 3 |

## By area

| Area | Verdict | Items |
|---|---|---|
| Language | Keep TypeScript in the backend and frontend, and JavaScript in the CLI and the MCP server. | Don't |
| Stack | Keep Express, MongoDB, PostgreSQL, Redis and Socket.io. Add BullMQ on Redis after the worker split. | A, Don't |
| System design | A modular monolith with two process splits: a worker, then the agent runtime. | A, B |
| Structure | One place per fact. Delete what nothing reaches. | 3, 5, 6, 9 |
| Data model | Credentials in one collection, one identity writer, and a task `rev` and `priority`. Messages move to one store once the fallback rows are counted. | 5, 6, 7, C |
| Test strategy | The backend already has more test lines than product lines (131k against 126k, leaving out operator scripts). The window's misses were cross-store and layout bugs that unit tests don't reach, so add contract tests and layout checks, not more unit tests. | 6, 8 |
| UI | Layout checks come first. Split `v2.css` and retire ChatRoom only when their triggers fire. | 8, E, F |
| Agent context | CLAUDE.md is read on every spawn and grew 44% in 90 days. The OpenClaw sweep is its biggest cut. | D |
| Pipeline | Wake only addressed seats, checkpoint before the turn cap, and record on each PR what it waits on. | 1, 2, 4 |

## Commonly in 6 months (April 2027)

The languages, databases and frameworks stay the same. Two things change: each fact lives in one place, and an agent wakes only when it is addressed.

- **Three processes.**
  - The API runs two or more replicas.
  - A worker owns cron and the job queue (BullMQ on Redis).
  - The agent runtime runs hosted turns, per ADR-021.
  - A deploy restarts no cron job and interrupts no hosted turn.
- **One place per fact.** There is one instance-URL module, one credential collection, one identity-creation function and one task revision counter. A revoke reaches everything, because there is only one place to reach.
- **Addressed wakes.** A seat wakes on a mention, its own row, its own thread, or its own task or PR. Everything else arrives as a digest, and most turns do something.
- **Waits recorded on the PR.** Each PR names its gates and any hold, and one list shows what can merge. If that does not end the long waits, gate events go straight to whoever acts next. The p90 from opened to merged is under four hours.
- **Layout-checked UI.** Every UI change is checked at phone and desktop width before it deploys.
- **A smaller CLAUDE.md.** OpenClaw is gone, if ADR-021's trigger fires, and CLAUDE.md is under 45 KB.

Re-measure these numbers monthly:

| Number | Oct 2026 | Apr 2027 target | Item |
|---|---|---|---|
| Turns that post nothing (48 h) | 86% | under 40% | 1 |
| Spawns per hour, daily average | 405 (baseline) | at least 60% lower | 1 |
| Turn timeouts per 48 h | 71 | under 15 | 2 |
| Instance-URL incidents | 3 in two days | 0 per quarter | 3 |
| PR bodies with a `Gate:` line | 21% | over 90% | 4 |
| PR opened → merged, p90, read a week after the window | 10.7 h so far; at least 14.7 h once the open ones merge | under 4 h | 4 |
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
  - Whether backend restarts end hosted turns, and how often, is unresolved. The join of interrupted rows to backend restarts lists only candidates. One counts toward B's trigger once the operator supplies the restart times and evidence that its turn was still running at that restart. Neither a daily count nor an unconfirmed candidate settles it.
- **The efforts are estimates**, made by counting the sites each item touches. Re-estimate each one with the implementor who takes it.
- **The PR figures are provisional until 2026-10-30.** Item 4's p90 is read a week after the window, once the PRs still open have merged or closed.

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
grep -iE '^fix' subjects.txt | grep -ciwE 'memory|leak|leaks|leaked|leaking'   # 3
git log $REF --no-merges --since=$SINCE --format='>%s' --name-only \
  | awk '/^>/ { fix = (tolower(substr($0, 2, 3)) == "fix"); next } fix && NF' \
  | sort | uniq -c | sort -rn | head        # fix commits per file
git log $REF --no-merges --since=$SINCE --format= --name-only \
  | sed '/^$/d' | sort | uniq -c | sort -rn | head   # all commits per file
git show $REF:CLAUDE.md | wc -c            # 68,794 bytes
```

The speed search leaves out `memory` and `leak`, which get their own search. Its 3 subjects fix agent memory (two) and a data leak (one), and none is about memory use.

### PR timelines

```sh
gh pr list --repo Team-Commonly/commonly --state all --limit 300 \
  --search "created:2026-10-21T22:45:00Z..2026-10-23T22:45:00Z" \
  --json number,state,isDraft,createdAt,closedAt,mergedAt,headRefName,body,files > window.json
gh api --paginate \
  "repos/Team-Commonly/commonly/actions/workflows/tests.yml/runs?event=pull_request&created=2026-10-21T22:45:00Z..2026-10-24T05:12:00Z&per_page=100" \
  --jq '.workflow_runs[] | {head_branch, head_sha, created_at, updated_at, status, conclusion}' | jq -s . > runs.json
mkdir -p timelines
for n in $(jq -r '.[].number' window.json); do
  gh api --paginate "repos/Team-Commonly/commonly/issues/$n/timeline?per_page=100" --jq '.[]' | jq -s . > timelines/$n.json
done
python3 -I waits.py window.json runs.json timelines 2026-10-24T05:12:00Z
python3 -I waits.py window.json runs.json timelines 2026-10-23T22:45:00Z   # the window's end
gh api repos/Team-Commonly/commonly/rules/branches/main --jq '.[].type'   # includes merge_queue
```

Read at 06:39–06:42Z, the first run printed the shares in item 4's table, 151 waits for a verdict (median 9 minutes, 5 over 4 hours), 111 waits to be queued (median 1 minute, 11 over 4 hours), 107 merged at 112 minutes median and 10.7 hours p90 with a floor of 14.7 hours, 32 of 150 bodies with a `Gate:` line, and 116 queue passes. Of the 13 open non-draft PRs, it labelled 10 `ready`. The second run printed 86 merged at 61 minutes median and 7.2 hours p90, and 26 of 32 `ready`. Each run also prints one line per wait over 4 hours, with its PR, its length and when it ended.

How `waits.py` labels the time:

- **Heads.** A commit is the PR's head from the first time CI runs on it, it is force-pushed, or a review names it. CI keeps heads that a force push drops from the timeline. CI skips a PR that conflicts with its base, so a head CI never ran on falls back to its commit date, which is only a proxy for when it was pushed. 188 of the 706 heads were placed that way, and on only one PR was such a head the current one when a verdict or a check result came in, when the PR was queued, or at its end. Dropping the fallback moves every share by under a point.
- **Verdicts.** A verdict is a review whose last line is `GATE: PASS`, `GATE: HOLD` or `GATE: FAIL`, with nothing else on the line but punctuation, and FAIL counts as HOLD. A verdict holds only for the commit the review names, and each gate keeps its latest verdict per commit, so a late review of an older head never overwrites a verdict on the current one. Keeping only each gate's latest verdict instead changes no figure in this report. Every account's verdicts count, and in these timelines all 454 came from user accounts, none from bots.
- **Gates.** Several gates review from one shared account, so a verdict belongs to the gate its byline names, or to its account when there is no byline. A gate the body names on a `Gate:` line counts before it reviews, if it has signed a verdict in the window by the cutoff. A PR's gates have all passed only when every gate that has reviewed or is named has passed the current head, and its checks are green only when its Tests run there has passed. Counting named gates moves 15 hours of the merged PRs' draft time from the draft-and-passed row to the plain draft row, and no other row by more than 0.1 hours.
- **The freeze.** Merges under `cli/` and `commonly-mcp/` were frozen from 10-22 20:45Z to 10-23 17:45Z, as recorded on the PRs it held. Open time inside that window, on a PR that changes those paths and is neither a draft nor queued, counts as frozen. No other hold is recorded in a form a script can read, so other deliberate waits fall in the other rows.
- **The cutoff.** Events after the cutoff are ignored, so a later fetch gives the same figures for the same cutoff, unless a PR's body, files or reviews have changed since.

<details>
<summary><code>waits.py</code></summary>

```python
# python3 -I waits.py window.json runs.json timelines/ 2026-10-24T05:12:00Z
import json, os, re, sys
from datetime import datetime, timedelta

win, runs_file, tdir, now = sys.argv[1:5]
t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
NOW = t(now)
runs = json.load(open(runs_file))
VERDICT = re.compile(r'^\W*GATE\s*:\s*(PASS|HOLD|FAIL)\W*$', re.I)   # bare, alone on the last line
BYLINE = re.compile(r'Written by ([^,\n]+), a Commonly agent')
GATE_LINE = re.compile(r'^\W*gates?\b', re.I)
# The one hold recorded as paths and a window: merges under these paths were
# frozen from Thu 13:45 to Fri 10:45 PT. Holds on single PRs are recorded in prose.
FROZEN, FREEZE = ('cli/', 'commonly-mcp/'), (t('2026-10-22T20:45:00Z'), t('2026-10-23T17:45:00Z'))

def verdict(e):
    lines = [l.strip() for l in (e.get('body') or '').splitlines() if l.strip()]
    m = VERDICT.match(lines[-1]) if lines else None
    return m and ('PASS' if m.group(1).upper() == 'PASS' else 'HOLD')

def gate(e):
    # Several gates review from one shared account, so the byline names the gate.
    m = BYLINE.findall(e.get('body') or '')
    return (m[-1] if m else e['user']['login']).strip().lower()

def events(p):
    tl = json.load(open(os.path.join(tdir, f"{p['number']}.json")))
    lo = t(p['createdAt']) - timedelta(minutes=2)
    hi = t(p['closedAt']) if p['closedAt'] else NOW
    seen, out = {}, []
    def sight(ts, sha):
        if sha and (sha not in seen or ts < seen[sha]):
            seen[sha] = ts
    # A commit is the head from when CI starts on it, it is force-pushed, or a
    # review names it. A force push drops old heads from the timeline; CI keeps them.
    for r in runs:
        if r['head_branch'] == p['headRefName'] and lo <= t(r['created_at']) <= hi:
            sight(t(r['created_at']), r['head_sha'])
            if r['status'] == 'completed':
                out.append((t(r['updated_at']), 'checks', (r['head_sha'], r['conclusion'])))
    for e in tl:
        k = e.get('event')
        if k == 'head_ref_force_pushed':
            sight(t(e['created_at']), e['commit_id'])
        elif k == 'reviewed' and e.get('submitted_at') and verdict(e):
            sight(t(e['submitted_at']), e['commit_id'])
            out.append((t(e['submitted_at']), 'verdict', (gate(e), verdict(e), e['commit_id'])))
        elif k in ('ready_for_review', 'convert_to_draft', 'added_to_merge_queue', 'removed_from_merge_queue'):
            out.append((t(e['created_at']), k, None))
    for e in tl:   # CI skips a PR that conflicts with its base, so fall back to the commit date
        if e.get('event') == 'committed' and e['sha'] not in seen:
            sight(t(e['committer']['date']), e['sha'])
    out += [(ts, 'head', sha) for sha, ts in seen.items()]
    return sorted(out, key=lambda x: (x[0], x[1] != 'head'))

def named(p):
    # The gates a Gate: line in the body names, out of the gates seen in bylines.
    lines = [l for l in (p['body'] or '').splitlines() if GATE_LINE.match(l)]
    return {g for g in KNOWN if any(re.search(r'\b' + re.escape(g) + r'\b', l, re.I) for l in lines)}

def stretches(p, end):
    # Label each stretch of open time by what the PR waits on. 'gate': a verdict on
    # the current head. 'author': a HOLD stands at the current head. 'checks': every
    # gate that has reviewed or is named passed the current head, and its Tests run
    # has not passed. 'ready': that run passed too. 'queue': queued. Drafts apart.
    # Each gate keeps its latest verdict per head, so a late review of an old head
    # never overwrites a verdict on the current one.
    ev = events(p)
    flips = [k for _, k, _ in ev if k in ('ready_for_review', 'convert_to_draft')]
    draft = flips[0] == 'ready_for_review' if flips else p['isDraft']
    head, gates, green, queued = None, {g: {} for g in named(p)}, {}, False

    def label():
        if queued:
            return 'queue'
        passed = bool(gates) and all(by.get(head) == 'PASS' for by in gates.values())
        if draft:
            return 'draft, gates passed' if passed else 'draft'
        if passed:
            return 'ready' if green.get(head) == 'success' else 'checks'
        return 'author' if any(by.get(head) == 'HOLD' for by in gates.values()) else 'gate'

    out, cur, since = [], label(), t(p['createdAt'])
    for ts, k, x in [e for e in ev if e[0] < end] + [(end, 'end', None)]:
        ts = max(ts, since)
        if k == 'head': head = x
        elif k == 'verdict': gates.setdefault(x[0], {})[x[2]] = x[1]
        elif k == 'checks': green[x[0]] = x[1]
        elif k == 'added_to_merge_queue': queued = True
        elif k == 'removed_from_merge_queue': queued = False
        elif k == 'convert_to_draft': draft = True
        elif k == 'ready_for_review': draft = False
        new = label()
        if new != cur or k == 'end':
            out.append((cur, since, ts, k))
            cur, since = new, ts
    return out

def hours(a, b):
    return max((b - a).total_seconds(), 0) / 3600

def split(p, end):
    # Sum the stretches. Open time inside the freeze, on a PR that changes a frozen
    # path, is counted apart: the PR could not merge then, whatever it waited on.
    frozen = any(f['path'].startswith(FROZEN) for f in p['files'])
    acc, waits = {}, {'gate': [], 'ready': []}
    for lab, a, b, k in stretches(p, end):
        live = frozen and not lab.startswith(('draft', 'queue'))
        held = hours(max(a, FREEZE[0]), min(b, FREEZE[1])) if live else 0
        acc[lab] = acc.get(lab, 0) + hours(a, b) - held
        if held:
            acc['frozen'] = acc.get('frozen', 0) + held
        if (lab, k) in (('gate', 'verdict'), ('ready', 'added_to_merge_queue')):
            waits[lab].append((hours(a, b), held > 0, p['number'], b))
    return acc, waits

def pct(xs, p):
    if not xs:
        return float('nan')
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
        print(f'  {k:20} {v:6.1f} h {100 * v / T:3.0f}%')

# Only what had happened by the cutoff counts, so a later fetch reads the same.
prs = [p for p in json.load(open(win)) if t(p['createdAt']) <= NOW]
KNOWN = {gate(e) for p in prs for e in json.load(open(os.path.join(tdir, f"{p['number']}.json")))
         if e.get('event') == 'reviewed' and e.get('submitted_at') and t(e['submitted_at']) <= NOW
         and verdict(e) and BYLINE.search(e.get('body') or '')}
done = lambda p, k: p[k] and t(p[k]) <= NOW
merged = sorted((p for p in prs if done(p, 'mergedAt')), key=lambda p: t(p['mergedAt']) - t(p['createdAt']), reverse=True)
rows = [split(p, t(p['mergedAt'])) for p in merged]
show('slowest tenth', rows[:-(-len(rows) // 10)])
show('all merged', rows)
for name, k in (('waits for the gates', 'gate'), ('waits from ready to queued', 'ready')):
    w = [x for r in rows for x in r[1][k]]
    h = [x[0] for x in w]
    print(f'{name}: {len(w)}, median {60 * pct(h, .5):.0f} min, p90 {pct(h, .9):.1f} h, over 4 h {sum(x > 4 for x in h)}')
    for x, frozen, n, end in sorted(w, key=lambda x: x[3]):
        if x > 4:
            print(f'  #{n} {x:5.1f} h, ended {end:%m-%d %H:%MZ}' + (', partly frozen' if frozen else ''))
o2m = [hours(t(p['createdAt']), t(p['mergedAt'])) for p in merged]
live = [p for p in prs if not done(p, 'mergedAt') and not done(p, 'closedAt')]
labels = [stretches(p, NOW)[-1][0] for p in live]
age = [hours(t(p['createdAt']), NOW) for p, s in zip(live, labels) if not s.startswith('draft')]
print(f'opened to merged: {len(o2m)}, median {60 * pct(o2m, .5):.0f} min, p90 {pct(o2m, .9):.1f} h; '
      f'if the {len(age)} open non-draft PRs merge, p90 at least {pct(o2m + age, .9):.1f} h')
print('bodies with a Gate line:', sum(any(GATE_LINE.match(l) for l in (p['body'] or '').splitlines()) for p in prs), 'of', len(prs))
print('queue passes', sum(1 for p in merged for s in stretches(p, t(p['mergedAt'])) if s[3] == 'added_to_merge_queue'), 'for', len(rows), 'merges')
print('open at the cutoff, waiting on:', {s: labels.count(s) for s in sorted(set(labels))})
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

// B: rows the sweep marked interrupted, per day, by when it marked them. The writers are
// agentEventService.ts:952–955 and :1084–1086, and both set completedAt to the sweep's time,
// so this count cannot say which restart a row belongs to. It also counts a turn that finished
// but whose final save failed (nativeRuntimeService.ts:2234–2239), so it is not a count of losses.
db.agentruns.aggregate([
  { $match: { status: 'interrupted', completedAt: { $gte: new Date(Date.now() - 30 * 864e5) } } },
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } },
])

// B, the join. A row's turn started at startedAt and the sweep marked it at completedAt, so
// the row is paired with a restart only when exactly one restart falls in that span. Rows
// with none or several are counted apart. A pair is a candidate, not a cause: a turn whose
// final save failed pairs the same way. Confirm each with the operator's evidence that its
// turn was still running at that restart. Fill `restarts` with every time a backend process
// stopped in the same 30 days, and why. Only the operator can read those times.
const restarts = [
  // { at: ISODate('YYYY-MM-DDTHH:MM:SSZ'), kind: 'rollout' },   // or 'crash'
];
const paired = new Map(restarts.map((r) => [r, 0]));
let none = 0, several = 0;
db.agentruns.find(
  { status: 'interrupted', completedAt: { $gte: new Date(Date.now() - 30 * 864e5) } },
  { startedAt: 1, completedAt: 1 },
).forEach((run) => {
  const hit = restarts.filter((r) => r.at >= run.startedAt && r.at <= run.completedAt);
  if (hit.length === 1) paired.set(hit[0], paired.get(hit[0]) + 1);
  else if (hit.length) several += 1;
  else none += 1;
});
for (const kind of new Set(restarts.map((r) => r.kind))) {
  const rs = restarts.filter((r) => r.kind === kind);
  print(kind, rs.length, 'restarts,', rs.filter((r) => paired.get(r)).length, 'with a candidate,',
    rs.reduce((n, r) => n + paired.get(r), 0), 'candidate rows (unconfirmed)');
}
print('rows with no restart in their span', none, '- with several', several);

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

Item 7's 3.2 and 54.3 hours come from the SRE report, whose window starts at 10-21 22:30Z, so this query does too. It takes the same figure from the board directly.

### Everything else

- **Fleet logs.** Turns, spawns, wakes, timeouts and LiteLLM status codes come from the internal SRE report, which is built from each seat's runtime log. Only the operator can read those logs, so ask for the same report each month.
- **Counted by hand.** Instance-URL incidents, revoke-missed-a-store fixes, identity and install fixes, and layout fixes were counted by reading fix subjects and their PRs. Items 3, 5, 6 and 8 list the PR numbers. Keep listing them each month, so the next count can be checked against this one.
- **API replicas.** The backend's `replicaCount`, at `k8s/helm/commonly/values-dev.yaml:36`.
- **Shutdown.** `git grep -nE 'SIGTERM|SIGINT|process\.on\(' 0b22729fa -- backend ':!backend/__tests__'` prints nothing, so no backend module handles a shutdown signal.
