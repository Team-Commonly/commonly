# ADR-038: Show where each agent is working, with no locks

**Status:** **Accepted** 2026-11-26 (F657), ratified by the maintainers under the founder's standing
delegation, after two review rounds whose rulings are written below as decisions. Nothing here is built.

**Acknowledged unknowns** (detail in §6 and §7; accepting this ADR does not settle them):
- overlap between a fork and its upstream is missed;
- foreground `commonly agent run` without a daemon doesn't report;
- Linux confined seats don't report until a sandboxed git wrapper exists there;
- edits in another worktree than the placement `cwd` aren't seen;
- an agent serving two consented pods flickers between them;
- seats that push through `commonly::<grant>` get no repo;
- the two-step `branch`, then `files` consent is untested with users;
- the cost of the reads on very large repos is unmeasured.

**Number.** ADR-036 is claimed by open PR #4223 and ADR-037 by open PR #4377, so this takes 038.

**Grounded at:** `origin/main` `b99a83619` (2026-11-26). Code was read, not run.

**Relates to:**
- ADR-008: the seat's `workspace.path` is the wrapper's spawn `cwd`.
- ADR-011: shell-first.
- ADR-018: claims are leases, unchanged.
- ADR-026: the daemon and its machine credential.
- ADR-028 D1 and D7, both **Proposed**: a *declared* work area on a claim, and an advisory-only
  ledger.
- ADR-034 D4: no new Mongo model.

**Scope boundary.** ADR-028 D1 proposes a work area an agent *declares* when it claims a task. This
ADR is the *observed* counterpart: what the agent's workspace actually holds, read by its wrapper. It
needs no claim and no task, and it settles nothing in ADR-028. It lifts none of ADR-011's paused
tracks. The kernel change is a new event value on an existing runner route, and everything a person
sees is shell.

## 1. Problem

Two people in one pod each run an agent on the same repository. Neither person, and neither agent, can
see that the other agent is changing the same files until the second PR conflicts, or merges clean and
duplicates work. The wrapper already knows the folder each turn runs in, and that folder is usually a
git checkout. The pod should be able to see which repo, branch and files each agent has changed.

What this is not:
- **Not a lock.** Nothing here can refuse an edit, a commit, a push or a post.
- **Not a claim.** No repo area is reserved, and ADR-018's leases are unchanged.
- **Not code ownership.** No path is assigned to anyone, and nothing routes review by path.

It's awareness. An agent that reports nothing shows nothing, and nothing treats silence as a fault.

## 2. Kernel and shell

**Who reports.** The cli wrapper, never the model. `placeTurn()` in `cli/src/commands/agent.js`
resolves `placement.cwd` before every turn. After the turn's `settled` report
(`createRuntimeReporter`, `cli/src/lib/runtime-observation.js`), the wrapper starts the git read.
The read is fire-and-forget: it runs within a 5 s budget (`runReadonlyGit`'s `timeoutMs`) and never
delays the turn, its acks or the next poll.

**The wrapper sends nothing when any of these holds:**
- the turn ran public: `placement.reason` is set, or the effective trust is `public`
  (`effectiveSandboxTrust(placement.environment?.sandbox?.trust)`, the check at about line 3218 that
  gates memory writes);
- the turn's batch held events from more than one pod;
- the seat is confined on Linux. There's no sandboxed git wrapper there yet, so phase 1 sends nothing;
- the `cwd` isn't in a git work tree;
- any check under *The git reads* below fails.

**The git reads (new module: `cli/src/lib/work-state.js`).** The `status` and `diff` reads go
through `runReadonlyGit`. The origin read can't, because `readonlyGitArgv` refuses `config`
(`git-readonly.js:296-297`). It's a separate fixed argv that reuses the same `TOP_LEVEL` flags and
`readonlyGitEnv`, which `git-readonly.js` exposes through a new export. `config` is never added to
`READONLY_GIT_SUBCOMMANDS`, because the seat's own `workspace_git` tool shares that list and `config`
has write forms. All three reads therefore get:
- system and global config are off, and `core.fsmonitor` is forced off;
- git contacts no remote, and `GIT_CEILING_DIRECTORIES` sits at the workspace;
- pathspecs exclude `.env*`, `.npmrc`, `.yarnrc*`, `.commonly` and `.codex`.

That runner's own header says a repo-defined clean filter still runs and relies on a sandbox to
contain it. So:
- **A confined seat on macOS** wraps each one-shot git argv with `wrapArgvWithSeatbelt`
  (`cli/src/lib/sandbox/seatbelt.js`) directly: workspace read-only, no network. This is new code with
  its own test. It isn't `confinedWorkspaceGitServer`, which wraps a long-running MCP server.
- **Any read outside a sandbox** first runs the check in `refuseCodeRunningGitSetup`
  (`cli/src/lib/sandbox/workspace-git-config.js`). That asks git which repository it would open and
  what config it carries. Any filter, `core.sshCommand`, `core.hooksPath`, `core.worktree` or other
  program-naming key in that config, or a hook, means nothing is sent.

  That function is synchronous (`spawnSync`, 10 s per call) and throws when git's answer can't be
  read, so phase 1 doesn't call it as-is. It runs an async variant of the same check before every
  read, never a cached result. A cache keyed on file mtimes misses a config source the key leaves
  out (`config.worktree`), and anything that can write the config can also set its mtime back. The
  check refuses `include.path` and `includeIf` keys outright, so an included file is never trusted.
  Two git spawns fit inside the 5 s budget. The wrapper catches any throw and sends nothing.

**`.git` symlinks and gitdir files.**
- *Inside the sandbox*, git follows a `.git` symlink or a `gitdir:` file only as far as the profile
  lets it read. A target outside the readable set fails the read, and nothing is sent.
- *Outside a sandbox*, phase 1 requires `.git` at the workspace root to be a plain directory. A
  symlink or a `gitdir:` file means nothing is sent, so a linked worktree used as a workspace
  isn't read without a sandbox.

**The reads themselves:**
1. `status -z --porcelain=v2 --branch --ignore-submodules=all`. This returns branch, head SHA and
   uncommitted paths. `-z` keeps odd file names intact.
2. `config --local --no-includes --get remote.origin.url`. This is the one argv outside the
   five-subcommand allowlist, and it's new.
3. `diff --name-only -z <base>...HEAD`. This returns the paths committed on the branch but not yet
   merged, using local refs only. `<base>` is `refs/remotes/origin/HEAD`, else `origin/main`, else
   `origin/master`. A base whose ref is missing (`ok: false`) means "try the next base", never
   "no repo", because "no repo" clears the record. With none of them, only uncommitted paths are
   sent.

The parser stops at `runReadonlyGit`'s `[output truncated …]` trailer and never reads it as a path.

**The carrier: extend `POST /api/agents/runtime/observation`, add no route.** That route
(`backend/routes/agentsRuntime.ts`, `recordRuntimeObservation` in
`backend/services/agentRuntimeObservation.ts`) is already per agent, per turn, and authenticated by
the daemon's machine credential through `createMachineReportClient` (`cli/src/lib/own-key-launch.js`).
It gains one event value, `work` (new), sent as its own request. An older backend answers 400, which
the reporter already swallows, so it never costs the `settled` outcome.

The route has so far carried only runner metadata. From now on it also carries consented workspace
metadata, and the header comment on `AgentRuntimeObservation.ts` changes to say so.

**An unconfined seat runs as its owner, so it can read the daemon credential and post a forged `work`
report.** The server's checks are what make that harmless. A report lands only when all of these hold:
- the agent is installed (active) in the named `podId`;
- the owner consented for that pod;
- the pod is confirmed private (§4).

A forged report can therefore say false things only about the agent itself, and only in a pod its
owner opened.

**Why not the machine heartbeat or `/placement`.** `recordMachineHeartbeat` reports per computer, lists
agents by run state only, runs on the daemon's cadence and has no pod. `/api/agent-binding/placement`
is an owner-only read of the computer binding and carries nothing from the computer.

**The pod read: extend `GET /api/pods/:podId/agent-states`, add no route.** Each agent row gains an
optional `work` object, subject to §4's read rules.

**Shell, phase 1.** One line under the agent's row in `V2Inspector.tsx`, where `agentState` already
derives `working`: `owner/name · branch · N files`. It expands to the path list and a relative "as of"
time, plus §5's overlap sentence. The pod-level "who's working where" line is deferred.

## 3. The record

**Fields.** A new subdocument `work` on `AgentRuntimeObservation`:

| Field | Contents |
|---|---|
| `repo` | `host/owner/name`, from the origin-URL rule below, or null |
| `branch` | `branch.head`; null when detached |
| `headSha` | `branch.oid`, 40 hex characters |
| `paths` | uncommitted tracked paths (staged, unstaged, deleted, and both sides of a rename) together with the committed-unmerged paths. Relative to the repo root, de-duplicated and sorted, at most 100 |
| `pathsTruncated` | true when the cap of 100 or the per-path length cap dropped any |
| `untrackedCount` | a count only, never names |
| `podId` | the pod of the turn's events |
| `receivedAt` | server time when the report landed; the wrapper's own `at` is never used |

**Origin URL, by allowlist.** The URL is accepted only with these schemes, and anything else gives
`repo: null`:

| Accepted | Refused (`repo: null`) |
|---|---|
| `https://`, `http://`, `ssh://`, `git://` | `<helper>::` of any kind, including `ext::`, `fd::` and `commonly::` |
| scp-like `[user@]host:path` | `file://` and local paths |

From an accepted URL, the wrapper:
- drops userinfo (which can hold a token), the port, the query, the fragment and a trailing `.git`;
- lower-cases the host;
- keeps deeper group paths (`host/group/sub/name`).

The server re-validates `repo` against `^[a-z0-9.-]+(/[A-Za-z0-9._-]+){2,}$` and drops the whole
`work` object on a mismatch.

**Per-path cap.** It reuses the observation route's existing 256-character `scalar` limit.

**Never sent:**
- absolute paths, or anything naming the workspace folder, the home directory or the user;
- file contents or diffs;
- untracked file names;
- any path starting `..` or `/`;
- the paths `git-readonly.js` excludes;
- remote credentials, and remotes other than `origin`;
- free text of any kind.

The server's normalizer is new, written in the style of `normalizeAgentStates`. It enforces the same
rules.

**Storage.** The record is a field on the existing Mongo model `AgentRuntimeObservation`, one row per
agent, keyed by `agentUserId`. ADR-034 D4 freezes new models, not fields, and this model is already on
the freeze test's list, so the field moves to Postgres with the model when its wave comes.

**Lifetime.** Each report overwrites the record, and nothing keeps history.

*Cleared by:*
- a `connected` event, when a new wrapper process starts;
- a `work` report that finds no repo;
- the owner turning consent off for the record's pod (§4).

*Hidden by readers when:*
- the record is older than 20 minutes by `receivedAt`;
- `observation.machineId !== bot.botMetadata.machineId`, meaning the agent has moved or been
  unbound.

**Why a 20-minute window.** It's chosen for simplicity, not forced by liveness. A batch turn does
stay `listening`. `processEventBatch` renews its deliveries every 60 s (`agent.js:4669, 4688`), and
the renew route records a listener check-in (`agentsRuntime.ts:1872-1874`). So reading `listening`
would also work. One window, measured on the server's receive time, is simpler. It's set at the
15-minute default turn timeout plus margin.

The consequence: a record is hidden once its last report is 20 minutes old. That includes an idle
agent whose tree is still dirty, since nothing reports between turns.

## 4. Privacy and consent

File names can be sensitive (`layoffs-2027.md`, a customer's name in a fixture). One agent on one
computer has **one workspace shared across every pod it serves**, so what it changes for pod A is
visible on disk when pod B wakes it. That's why consent is per (agent, pod), never per agent.

**Write.** The control is a new field `workSharing: { mode: 'off' | 'branch' | 'files', setBy, setAt }`
on the pod's `AgentInstallation`. It sits outside `config`, so the installer's generic config PATCH
(`PATCH /api/registry/pods/:podId/agents/:name`, `backend/routes/registry/agent-config.ts`) can't touch
it. That route writes the model and effort controls. `manage-settings.ts` reads runtime state and
writes per-pod settings with an installer-or-admin rule.

Who can set it:
- only the agent's runtime-identity owner (`ownsRuntimeIdentity`, `backend/services/runtimeIdentityOwnership.ts`);
- no installer path, no admin path, and no mention-installer path.

The write is a new route: `PUT /api/registry/agents/:name/work-sharing/pods/:podId`. Turning it on
shows the owner the pod's name and its member count, and says two things:
- the members of that one pod see the record;
- the record shows the agent's whole workspace, whichever pod the work was for.

Per-pod consent decides who sees it, not what's in it. The mode is `off` until the owner sets it.

**Uninstalling the agent from a pod resets `workSharing` there to `off`,** so a later reinstall by
someone else never revives the old consent.

**Delivery to the wrapper.** A daemon seat gets the mode for each pod through `/api/agent-binding/assigned`
(`services/seatEnvironmentProjection.ts`), not through `refreshSeatEnvironment`. With every pod `off`,
the wrapper runs no git at all.

**The server refuses a `work` report** whose `podId` meets any of these:
- it has no consent (`off`);
- it has no active installation of the agent;
- it is a DM pod: `agent-room`, `agent-dm` or `agent-admin`;
- it is not confirmed private. The server applies the same test as `podIsConfirmedPrivate`
  (`cli/src/lib/workspace-trust.js:24-30`): `!publicRead && !communityListed && joinPolicy === 'invite-only'`.

With `branch` mode, the server strips `paths` before storing.

**Off hides at once, and so does narrowing.** The off-write unsets `work` when the record's `podId` is
that pod. A write that changes `files` to `branch` unsets `work.paths` the same way. The read side
checks the current mode as well, so a record stored under `files` shows no paths once the mode is
`branch`, even if the write's unset failed. Nothing waits for a report.

**Read.** `agent-states` includes `work` only when all of these hold:
- the pod is the record's `podId`;
- the mode is on now, and the pod is still confirmed private and not a DM;
- the caller is in `pod.members`.

When the mode is `branch` now, the read drops `paths` before it returns the record, and before §5
computes overlap from it.

`DMService.canViewPod` is not the test, because it also admits instance admins and the ADR-001 §3.7
agent-dm fan-out. Neither of those gets `work`. The read has no admin bypass.

**Public seats never report.** The wrapper skips the read (§2) and the server refuses public pods
anyway.

## 5. Collision hint

**Overlapping means:**
- two agents both have a record shown in the same pod and inside the 20-minute window;
- both records name the same non-null `repo`;
- at least one path appears in both `paths` lists, as the same exact string.

Branches don't matter, because two branches editing one file still meet at merge. A truncated list
shows overlap only among the paths it kept, so the sentence says "at least". Untracked files never
overlap. **A fork and its upstream have different `repo` values, so overlap across them is missed in
phase 1.**

**What it does.** The hint is computed during the `agent-states` read. It isn't stored, sends nothing
and wakes nobody. The viewer sees one sentence when `ownsRuntimeIdentity` says they own either agent,
for example: "Your agent and Ben's agent both changed `src/auth.ts`." Other members see a quiet mark on
the shared paths. Nothing blocks.

**No attention row.** The five `AttentionItem` kinds (`mention`, `approval`, `decision`, `handoff`,
`blocked`) all ask the recipient to act, and Needs-you rows can become email (`NeedsYouEmail`). An
overlap is a heads-up, so no kind fits, and none is added in phase 1.

## 6. Phasing

**Phase 1** covers Claude Code and Codex seats under the daemon, on macOS confined or on any OS
unconfined. It builds:
- `work-state.js`;
- the `work` event and its server normalizer;
- the `work` field and the header change;
- `workSharing` and its owner-only route, and its projection in `/assigned`;
- the `agent-states` extension;
- the inspector line and the overlap sentence.

**Tests:**
- **DM and guest:** `agent-room`, `agent-dm` and `agent-admin` refuse the report and never show it.
  Neither an admin nor an agent-dm fan-out reader gets `work`.
- **Multi-pod:** a record for pod A never shows in pod B, and consent in A doesn't cover B.
- **Not confirmed private:** a `communityListed` pod, an open (`joinPolicy !== 'invite-only'`) pod,
  and a `publicRead` pod refuse and hide.
- **Off hides at once:** the off-write unsets `work`, and a read after it returns none, with no
  report in between.
- **Narrowing hides paths at once:** after `files` changes to `branch`, a read returns the record
  with no `paths` and §5 finds no overlap from it, with no report in between, including when the
  write's unset is skipped.
- **Uninstall resets consent:** after an uninstall and a reinstall by another person, the pod is
  `off` and refuses reports.
- **Who may flip it:** a mention-installer, a second installer and an instance admin each get a 403
  from the route, and the installer config PATCH can't write `workSharing`.
- **Normalizer:** credential-bearing and `<helper>::` URLs, `..` and absolute paths, the 100 and 256
  caps, excluded names, and the truncation trailer.
- **Wrapper:**
  - a public or effective-public turn runs no git;
  - the macOS confined read runs under `wrapArgvWithSeatbelt` and can't write the workspace;
  - a missing merge-base ref falls through to the next base and doesn't clear the record;
  - a throw from the code-running-config check sends nothing;
  - the check runs again before every read: a filter added after a clean read, with the config's
    mtime set back, sends nothing;
  - a Linux confined seat sends nothing;
  - a code-running git config or a non-directory `.git` outside the sandbox sends nothing;
  - a slow read doesn't delay the next poll.

**Deferred:**
- the pod-level "who's working where" line;
- foreground `commonly agent run` without a daemon;
- Linux confined seats, which need a sandboxed git wrapper;
- other harnesses, native and hosted runtimes, and webhook and MCP-only agents;
- agent-readable access through `GET /pods/:podId/context`, under ADR-028 D12;
- an Activity entry or an attention kind for overlaps;
- reports during a turn;
- linked worktrees and untracked file names;
- fork-aware overlap;
- links to a task, a PR or an ADR-028 claim.

## 7. Acknowledged unknowns

- **Worktrees.** Agents often edit in a `git worktree` of their own while the placement `cwd` shows
  a clean checkout. How common that is for wrapper seats hasn't been measured.
- **Multi-pod flicker.** One record per agent means an agent serving two consented pods disappears
  from one pod while it takes the other's turn.
- **Seats that push through `commonly::<grant>`.** These get `repo: null`. The grant record (ADR-033)
  names the repo, but phase 1 doesn't join the two subsystems.
- **Consent design.** Whether the two-step `branch`, then `files` consent is right hasn't been tested
  with users. The F657 study isn't in this repo.
- **Cost.** The added time of the three reads on very large repos hasn't been measured. The 5 s
  budget bounds it, and a read that times out sends nothing.
