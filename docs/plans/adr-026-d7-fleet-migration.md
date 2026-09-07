# ADR-026 D7 fleet migration plan

**Status:** prerequisite implementation in review (2026-09-07)

This is the operator-fleet cutover plan for ADR-026 D7. It keeps agent identity,
memory, tools, permissions, and paused state on the server and changes only who
starts and supervises a local seat. It does not add a launcher shim or a second
runtime API.

## Verified prerequisites

1. **Runtime fidelity.** The daemon work list carries the complete
   `config.environment` (workspace, sandbox, skills, MCP, model, and effort).
   Older installations that expose only `config.runtime.model/effort` remain
   compatible through a non-destructive overlay. The Codex adapter passes model
   on fresh and resumed runs and passes reasoning effort as
   `model_reasoning_effort` through `-c`, which is the supported Codex CLI
   surface.
2. **Existing-agent editing.** The existing registry PATCH route remains the
   source of truth: `PATCH /api/registry/pods/:podId/agents/:name` with
   `config.runtime` and/or a validated ADR-008 `config.environment`. The
   existing Agents Hub already uses this route; `commonly agent config` is the
   CLI path for the same operation. The daemon observes the edit on its next
   poll and restarts the affected child without minting a new identity.
3. **One runner.** `me.commonly.daemon` is the supported machine service and
   owns one child per bound identity. During migration, the legacy seat plist
   and `revive-fleet` are still owners; neither is removed while a seat is
   active. The daemon requests a graceful stop, waits for the old process to
   reach its idle boundary and exit, then starts the child and verifies normal
   work. Only after that proof does the operator remove that seat's old owner.

## Cutover order

1. Publish the CLI through `.github/workflows/npm-publish.yml`; install the
   exact published version on the target machine and record its version in the
   migration checkpoint.
2. Register and install the daemon service. Do not alter token files or paused
   installations. Confirm `commonly daemon status` and a successful heartbeat.
3. Select one **idle writer**. Record the old process PID/owner, token path,
   machine binding, and current paused/active state. Ask the old owner to stop
   gracefully; do not kill an active turn or start a parallel child.
4. Let the daemon adopt that identity, verify one ordinary message round trip,
   and confirm its model, effort, environment, memory, and tool permissions.
5. Remove only that seat's old launchd/revive ownership. Repeat one seat at a
   time, then migrate paused seats without waking them. Leads and the remaining
   fleet stay on the old owner until each seat has its own proof.

## Rollback and abort conditions

If adoption, heartbeat, or a normal round trip fails, stop the daemon child,
restore the recorded old owner, and leave the token and installation untouched.
Abort on any duplicate child, changed identity, lost environment key, unexpected
wake of a paused seat, or a non-idle stop. Rollback is per seat; it does not
require moving the already-proven seats back.

## Acceptance evidence

- Codex fresh and resume each receive the selected model and effort.
- An existing-agent model/config edit is visible through the UI and CLI and is
  applied by the daemon without replacing identity or memory.
- Exactly one runner owns the migrated seat after handoff; old ownership is
  absent only after the normal-work proof.
- Paused seats remain paused and all declared workspace, sandbox, skills, MCP,
  permissions, and tool settings are unchanged.
