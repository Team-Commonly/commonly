# Long-term review: what to refactor, and what to leave alone (2026-10)

**Status:** Interim. This is the ranked list and the six-month page. The full report lands on this same PR by 2026-10-25 01:00Z, so don't merge before then.
**Asked by:** the CTO (TASK-438).
**Measured at:** `main` `0b22729fa` (2026-10-24 03:59Z), unless a line says otherwise.

## The rule

Refactor only with numbers. Each item below names three things:

- the failure it removes, with the incident, PR or measured cost behind it;
- the effort, in implementor-days, including the usual two review rounds;
- the number that should move once it ships.

An idea with no number behind it goes under **Don't**, along with the condition that would change that.

## The finding

1. **The largest measured costs are in the pipeline, not in the code.** In 48 hours, 86% of agent turns posted nothing. The first gate verdict was HOLD on 48% of PRs, and HOLDs the author never saw turned a 61-minute median merge into a 7.2-hour p90.
2. **Most of tonight's incidents, and most of the 90-day fix hotspots, are one fact kept in several places.** Credentials live in three stores. Two URLs are read under four environment names. Agent identity is written from 11 places. The task revision is `updatedAt`.
3. **The usual rewrite candidates have numbers that say to leave them alone.** That covers the language, microservices, CI speed, a token pipeline, auth and Socket.io.

## Sources

- **Git history.** `main`, the 90 days to 2026-10-24: 1,484 non-merge commits, 39% of them typed `fix`.
- **GitHub lists, each capped by the API:**
  - the last 600 merged PRs (2026-09-24 to 10-24);
  - the last 200 Deploy Dev runs (09-04 to 10-24);
  - the last 400 Tests runs (about 15 hours).
- **Fleet logs** for the 48 hours to 2026-10-23 22:45Z, from an internal SRE report. They give turns, wakes, timeouts, failures and LiteLLM status codes, plus the PR pipeline (148 PRs, 86 merged).
- **Import-graph reachability** from `frontend/src/index.tsx` and `backend/server.ts`, at `0afed7ba1`.
- **Tonight's incident list**, as given with TASK-438.
- **The Raft study** (internal, 2026-10-23), cited by name only.

A count marked *keyword* comes from grepping commit subjects, so treat it as an upper bound.

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
- **The CLI loop.** `cli/src/commands/agent.js` (3,746 lines) took 25 fix commits in 90 days.
  - Twelve of them fixed wake, claim, cascade or retry semantics: #794, #906, #973, #1010, #1027, #1047, #1092, #1166, #2257, #2445 and #2532, plus one unnumbered.
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

### 2. Relay every HOLD to its author, and keep the gate ask on the PR (1 day)

**Removes:** PRs that sit idle after a HOLD nobody saw.

**Evidence:**

- The first verdict is HOLD on 48% of gated PRs (64/133).
- Once the author sees a HOLD, fixing it and re-gating take 9 minutes median (44 minutes p90). Even so, opened → merged is 61 minutes median and 7.2 hours p90.
- Only 34 of 148 PRs carried the gate ask on the PR. The rest asked in pod chat, which nothing that watches PRs can see.
- 31 open PRs from the window had an age median of 4.4 hours and a p90 of 20.5 hours.

**Shape:**

- A hook on GitHub review events posts a mention to the author's seat when a review ending in `GATE: HOLD` lands.
- The same hook flags any PR whose gate ask exists only in chat.

**Effort:** 1 day.

**Moves:**

- opened → merged p90, from 7.2 hours toward 2;
- gate asks made on the PR, from 23% to over 90%.

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
2. Read only the collection, and log every fallback hit.
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
- Every install path calls that function.
- A contract test runs each install path and asserts that every row exists afterwards.
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
- **Many authors.** In the last 30 days, at least eight different authors merged PRs touching the frontend: 177 touched `frontend/src`, and 44 of those touched `v2.css`.
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
- **Unreachable files at `0afed7ba1`:**
  - 17 frontend files (8,478 lines) are unreachable from `index.tsx`;
  - 66 backend files (9,484 lines) are unreachable from `server.ts`.
- **Script entry points may be live**, so the backend list needs a check file by file.

**Shape:**

- Delete the unreachable files.
- Add a CI reachability check that fails when a new unreachable product file appears.

**Effort:** 1 day.

**Moves:** unreachable product lines, from about 18,000 to 0, and kept there.

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
- **Deploys are frequent.** The last 200 Deploy Dev runs averaged 6.2 per active day, with a peak of 20.
- **Realtime is not the blocker.** Socket.io already fans out through the Redis adapter (`backend/config/socket.ts:76`).
- **The split is already proposed.** #2475 (TASK-355, open) moves the scheduler and the Discord gateway behind `RUN_WORKER`, with an opt-in worker Deployment.

**Trigger:**

1. Wait for item 1, which changes what the scheduler wakes.
2. Then add BullMQ on the Redis we already run.

**Moves:**

- API replicas, from 1 to 2 or more;
- deploys that restart a cron job, to 0.

### B. Move hosted turns into their own Deployment (5–8 days)

**Evidence:**

- **Hosted turns run inside the API process** (`dispatchInProcess`, `backend/services/agentEventService.ts:1333`).
- **A restart sweep re-runs turns that died with the process** (`agentEventService.ts:175`).
- **ADR-021 (Accepted) already specifies the target**, a separate `agent-runtime` Deployment. The chart has none yet.

**Trigger:**

- Wait until A is done.
- Wait until the restart sweep's counters show how many turns each deploy interrupts. That count needs a database read, and it is an open ask for the full report.

### C. Store chat messages only in PostgreSQL (2–3 days)

**Evidence:**

- **Two stores.** Messages live in PostgreSQL, with a MongoDB fallback:
  - fallback branches sit in 7 files, led by `server.ts` (7), the message controller (3) and `agentMessageService.ts` (2);
  - `pg/Message.ts` took 12 fixes in 90 days.
- **The fallback has caused a fault.** In #2543 (TASK-313, 10-23), an error after the PostgreSQL insert made the controller fall back and store a second copy in MongoDB. A fallback row cannot carry a reply edge.

**Trigger:** a count of MongoDB-fallback message rows, which is an open ask for the full report. If any were written in the last 30 days, this moves to Do now.

### D. Remove OpenClaw, per ADR-021 Phases 3–4 (3–5 days, plus 1 for docs)

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

**Evidence:**

- 13,160 lines;
- 146 commits in 90 days, 66 of them fixes;
- 44 PRs in the last 30 days;
- no count of merge conflicts exists yet.

**Trigger:** after item 8, if a conflict count shows more than two `v2.css` conflicts a week.

### F. Retire the legacy ChatRoom (2–3 days)

**Evidence:**

- **Still in use.** `ChatRoom.tsx` (4,962 lines) still serves Pod Tools. It is lazy-loaded at `frontend/src/v2/V2App.tsx:44` and rendered at `:254`.
- **Cheap to keep.** It took 4 fixes in 90 days.

**Trigger:** Pod Tools gets a v2 home.

## Don't

| Don't | The number that says leave it alone | Revisit if |
|---|---|---|
| Rewrite in another language | The measured costs are wakes, gates and turn length. A *keyword* search of 572 fix subjects in 90 days finds none about speed, CPU, memory or timeouts. | a profile shows a CPU-bound path that users feel |
| Split into microservices | Tonight's incidents were one fact kept in several places, and more services multiply the places. Two process splits (A, B) cover the deploy-coupling cost. | one part needs its own release cadence |
| Speed up CI | Queue time is 0. Wall time is 3.8–4.0 minutes median and 6.6–7.4 minutes p90. Superseding pushes cancel 33–37% of runs, which costs runner time and nobody's wait. | queue time appears |
| Port the CLI or the MCP server to TypeScript | `agent.js` took 25 fixes in 90 days, and none names a type error. They were semantics, which is item 1. | a type-class bug turns up |
| Burn down backend `.js` lint as a project | It has 2,279 errors, and 277 of the 282 dirty files are under `__tests__` (measured 08-28). The `.ts` gate already catches new violations. | never as a project; fix files as they are touched |
| Build a design-token pipeline | `tokens.css` (118 variables) and `v2.css` (104) share only 7 names, all motion, and those agree, so there is no drift to automate. Instead, fix the CLAUDE.md line that says the two "must move together". | the two files start sharing colour tokens |
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
| Test strategy | The backend already has more test lines than product lines (131k against 126k). The window's misses were cross-store and layout bugs that unit tests don't reach, so add contract tests and layout checks, not more unit tests. | 6, 8 |
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
- **Gates on the PR.** Every HOLD reaches its author without anyone relaying it, and the p90 time to merge is about two hours.
- **Layout-checked UI.** Every UI change is checked at phone and desktop width before it deploys.
- **A smaller CLAUDE.md.** OpenClaw is gone, if ADR-021's trigger fires, and CLAUDE.md is under 45 KB.

Re-measure these numbers monthly:

| Number | Oct 2026 | Apr 2027 target | Item |
|---|---|---|---|
| Turns that post nothing (48 h) | 86% | under 40% | 1 |
| Spawns per hour, daily average | 405 (baseline) | at least 60% lower | 1 |
| PR opened → merged, p90 | 7.2 h | about 2 h | 2 |
| Turn timeouts per 48 h | 71 | under 15 | 3 |
| Instance-URL incidents | 3 in two days | 0 per quarter | 4 |
| Revoke-missed-a-store fixes | 5 in six weeks | 0 per quarter | 5 |
| Identity and install fixes (90 d) | about 19 | 3 or fewer | 6 |
| Row created → claimed, p90 | 54.3 h | under 12 h | 7 |
| Layout fixes found after deploy (90 d) | about 14 | 3 or fewer | 8 |
| Unreachable product lines | about 18,000 | 0 | 9 |
| API replicas | 1 | 2 or more | A |
| CLAUDE.md size | 68.8 KB | under 45 KB | D |
| Fix share of commits (90 d) | 39% | under 25% | all |

## Open for the full report

- **Reconcile with the row.** This interim works from tonight's incident notes. The full report checks them against the TASK-438 row's own notes.
- **Two counts need a database read:**
  - MongoDB-fallback message rows in the last 30 days, which decides C;
  - turns the restart sweep re-ran per deploy, which decides how urgent B is.
- **Check the efforts.** Each effort estimate needs checking with the implementors who would take the item.
- **Commit the measurement commands**, so that the table above is re-measured the same way every month.
