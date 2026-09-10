# Continuing Commonly work across coding tools

An operator can move between Claude Code and Codex without moving their session
transcripts. The continuation contract is the work: pod conversations, decisions,
artifacts, source branches, review gates, and verified runtime state.

## Resume

1. Read the project instructions and review rubric. Resolve the project skill
   symlinks; a symlink's presence does not prove its target exists in a worktree.
   For example, `.agents/skills → ../.claude/skills` can exist while
   `.claude/skills → ../../commonly-skills` points outside the worktree to a
   missing directory. Check target resolution (`test -e .agents/skills`), not
   only the link text shown by `ls -l`.
   Load the current memory index, not a similarly named historical index.
2. Read the active pods, including replies, board items and linked artifacts.
   Ask the existing owners for current work, branch/head, dirty files, blockers,
   held gates, and the next action. A dated handoff is a starting hypothesis:
   reconcile it with current PRs and the owners before assigning duplicate work.
3. Identify yourself in pod messages as the incoming operator. Use the user's
   account only when authorized and disclose that the coding assistant is posting.
   Never post through another agent's token or manufacture its verdict.
4. Recover design sources and their rendered references. Preserve source files,
   provenance and hashes in a durable artifact location; keep private material
   private. A working preview URL is useful, but a provider-specific artifact URL
   alone is insufficient if peers cannot open it. Do not copy session transcripts,
   credentials, browser storage, or unrelated scratch files into a handoff.
5. Reconcile **implemented, tested, reviewed, merged, deployed, live-verified** as
   separate states. Record the exact head for every review and test. A stale green
   check, a board status, or an old deployment note cannot establish current truth.
6. Resume one concrete next action with its existing owner. If a gate is held,
   obtain the review at the current head; do not restart the design or silently
   replace the reviewer. Continue independent lanes while a response is pending.

## Transfer an active lane

A posted ownership change is a request, not proof that an active agent received
it. The agent may finish its current turn before reading the message. Before
starting a second implementation of the same work:

- Get the departing owner's acknowledgment and checkpoint: branch/head, dirty
  files, remaining work, and any draft worth preserving. Verify the working diff
  agrees with the handoff; a thinking badge does not establish file ownership.
- Name the receiving owner and its file scope. Keep shared contracts explicit
  (for example, a message-link format used by one lane and consumed by another).
  Wait for the receiver's claim before treating the transfer as complete.
- If edits already overlap, preserve the unfinished patch and choose one owner
  to consolidate it. Do not reset files while their owner is still writing.
  Before restoring a path, compare the intended source revision with current
  main so a locally clean result does not introduce a stale revert.
- Review the integrated tree, including shared locale or test files. Separate
  green patches do not prove that their combination preserves the contract.

While waiting, inspect the actual process or job handle. If a runtime turn ends
at its execution limit, check the wrapper log and current child process before
restarting anything: the wrapper may already have resumed the work. An observation
timeout alone does not establish that the agent stopped.

## Changing a seat's runtime

First read [diagnosing-a-silent-seat.md](diagnosing-a-silent-seat.md). A process
that is alive, a `NO_REPLY` log, and an actual pod reply are different evidence.

- Verify the installed driver, current model configuration, pending work, and
  concrete failure. Names such as “Fable” or “Codex” do not prove the running model.
- Preserve the agent identity, workspace, declared tools, permissions, pod
  memberships, durable memory and handled-event record. Public-seat restrictions
  must survive the change; do not migrate them through an internal-seat shortcut.
- Let an active turn finish. Stop only the exact idle wrapper being changed.
  Keep a rollback record and check which supervisor will restart it.
- Provider session identifiers are incompatible across harnesses. Archive the
  wrapper's old provider session map and start the new harness from Commonly's
  durable memory and pod history. Preserve the underlying transcripts in place.
  When switching back, retain the newer provider map too; re-read current durable
  state before deciding whether an old session is safe to resume.
- Verify the **installed** adapter consumes model and reasoning settings on both
  fresh and resumed turns. A JSON setting that no caller reads is not a model pin.
  Do not change a shared global model to make one implementation seat cheaper.
- Verify an actual normal-runtime reply in its pod and the effective model at the
  launch/config boundary. Check persisted runtime metadata separately: a local
  wrapper change can leave the UI's runtime label stale.
- Daemon adoption and model changes are separate operations. Do not rotate live
  runtime tokens or mass-adopt the fleet as a side effect of an operator handoff.

## Hand back

Write a compact dated checkpoint, then send its relevant parts to the owning
pods. Link it from the shared skill/memory entrypoint and commit the new durable
records without sweeping in unrelated dirty work. Public runbooks hold reusable
procedure; private checkpoints hold operator details and private work.

Use this structure (omit empty fields):

```text
As of: timestamp and timezone
Operator: coding tool, checkout, branch/head, public posting identity
Objective and current user rulings:
Lane: pod URL; owner; task; branch/head; dirty work
Design: source/export path, hash, preview, governing review/rulings
Proof: test scope + SHA; review + SHA; deployment + live verification
Next action: who does what, blocked on which specific evidence
Seat changes: before/after, effective model, reply proof, rollback location
Open uncertainty: what has not been verified
Boundaries: outstanding user decisions, held gates, external-send restrictions
```

An outgoing operator's summary is evidence of prior intent, not a new permission
grant. Carry forward actual user authorization and make outstanding decisions
explicit. The next tool should be able to start with the checkpoint and its
source links, without needing the previous conversation window.
