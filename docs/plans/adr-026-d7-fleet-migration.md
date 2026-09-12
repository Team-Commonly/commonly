# ADR-026 D7 fleet migration plan

**Status:** prerequisite implementation in review (2026-09-07)

This is the operator-fleet cutover plan for ADR-026 D7. It keeps agent identity,
memory, tools, permissions, and paused state on the server and changes only who
starts and supervises a local seat. It does not add a launcher shim or a second
runtime API.

## Verified prerequisites

1. **Runtime fidelity.** The daemon work list carries the complete supported
   ADR-008 `config.environment` projection (workspace, sandbox, skills, MCP,
   model, and effort). The separate `config.runtime.adapter` selector is a
   machine-local edit: the CLI validates its name and `detect()` result before
   PATCH, and the daemon accepts only an exact locally detected adapter (never
   a fallback) before restarting the child. Opaque keys and literal `mcp[].env` values are dropped
   at the server boundary; only exact adapter-resolved Commonly placeholder
   values remain (embedded placeholder strings are dropped with a value-free
   warning), while provider secrets stay out-of-band per ADR-008. Older
   installations that expose only `config.runtime.model/effort` remain
   compatible through a non-destructive overlay. The Codex adapter passes model
   on fresh and
   resumed runs and passes reasoning effort as `model_reasoning_effort` through
   `-c`, which is the supported Codex CLI surface.
   Claude detection and child launches also append the operator's
   `~/.local/bin` to the child `PATH`; launchd daemon environments commonly omit
   that directory even though the Claude executable is installed there.
2. **Existing-agent editing.** The existing registry PATCH route remains the
   source of truth: `PATCH /api/registry/pods/:podId/agents/:name` with
   `config.runtime` (including `adapter`, `model`, and `effort`) and/or a
   validated ADR-008 `config.environment`. The existing Agents Hub already
   uses this route; `commonly agent config` is the CLI path for the same
   operation. The daemon observes the edit on its next poll and restarts the
   affected child without minting a new identity.
3. **One runner.** `me.commonly.daemon` is the supported machine service and
   owns one child per bound identity. During migration, the legacy seat plist
   and `revive-fleet` are still owners; neither is removed while a seat is
   active. The daemon requests a graceful stop, waits for the old process to
   reach its idle boundary and exit, then starts the child and verifies normal
   work. Only after that proof does the operator remove that seat's old owner.

## Operator surface

The daemon is a detached, inspectable operator surface rather than another
foreground-only loop. `commonly daemon install` installs the login service;
`daemon start`, `stop`, and `restart` control it and return the terminal.
`commonly daemon run --foreground` remains the explicit troubleshooting path.
The foreground `commonly agent run <name>` banner points operators at the
service path instead of implying that the terminal can be closed safely.

`commonly daemon status --verbose` combines server liveness with the local
supervisor state (seat, adapter, model/effort, pid, last start/turn time, and
last error). `commonly daemon logs`, with optional `--seat <name>` and `-f`,
tails the daemon or one seat's log. The local state file is restricted to
0600 inside the 0700 daemon directory and is an allow-listed diagnostic
projection: it never contains runtime tokens, environment values, or bearer
credentials.

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
- A Claude adapter configured through the daemon resolves and launches when its
  binary is installed under `~/.local/bin`, including a launchd-style restricted
  parent `PATH`.
- An existing-agent model/config edit is visible through the UI and CLI and is
  applied by the daemon without replacing identity or memory.
- Exactly one runner owns the migrated seat after handoff; old ownership is
  absent only after the normal-work proof.
- Paused seats remain paused and all supported declarative workspace, sandbox,
  skills, MCP, permissions, and tool settings are unchanged; provider secrets
  remain out-of-band and are never returned by `/assigned`.

## Token rotation at cutover (pre-read, measured 2026-09-12)

Measured against `main` at `698ad45a` (auth middleware on a fresh database)
and on the operator laptop the fleet runs on today.

**What each mint path does to the old token.**

| path | rotates? | the old bearer afterwards |
|---|---|---|
| daemon adopt on the **same machine** (`ensureToken` finds `tokens/<agentName>.json`) | no, it reuses the file | valid, unchanged |
| daemon adopt on **another machine** (`POST /api/agent-binding/runtime-token`, `409 token_exists`, then `rotate: true`) | yes, totally: credential rows revoked, User and installation copies cleared | `401 Token revoked` |
| the same, when the seat's token lives **only on its installation** (legacy) | no: the route's `hasToken` reads only the User row, so nothing is revoked and a second token is minted | **still valid** |
| `commonly agent attach`, provision or reprovision with `force` (registry routes; the CLI always sends `force`) | clears `User.agentRuntimeTokens` only | **still valid**, through the installation copy and the still-active credential row |

So a cutover can fail in two ways, not one. A rotate can end a live seat.
A re-mint can also leave the old runner working beside the new one: a
duplicate child, which is an abort condition above that token state alone
does not reveal.

**Per seat.** The plan says 22 seats. The laptop has 16 running and 33 token
files, one per agentName, and no two files share a bearer. The fleet supervisor
keeps 15 of the running seats, and `quill` is already a daemon child: it was
adopted 2026-09-08, and no rotation was logged.

| seats | what relaunches the old runner | same-machine cutover rotates | breaks if the old owner is not stopped first | cross-machine cutover |
|---|---|---|---|---|
| sprint-impl, ux-lead, wren, kai, sage, juno, piper | a launchd seat plist (KeepAlive), and the fleet supervisor | nothing | a duplicate child: KeepAlive relaunches the old runner the moment it exits | rotates. The old runner dies at once if its token is on the User row, and keeps working if it is installation-only |
| sprint-review, vera, hq-support, anvil, vale, nova, reed, hollis | the fleet supervisor (relaunches within 10 minutes) | nothing | a duplicate child within 10 minutes | as above |
| quill | the daemon | — | — | — |

Three token files are stale and are not in the kept set: `claude-on-dev`
points at a retired API host, and `local-codex` and `local-stub` point at
localhost. `loadAgentToken` keys by agentName only and never compares
instanceId or instanceUrl, so a daemon adopting one of these would reuse a
dead file instead of minting. Delete them, or leave them unbound.

**Installation-only tokens, measured 2026-09-12.** This was a read-only query
in the cluster. For every active installation, it counted the token hashes
that are not on the matching bot User row and have no revoked credential row.
The auth middleware still accepts every one of these.

- **No identity is fully legacy.** Every identity whose installation carries
  tokens also has its current hash on the User row. The binding route's
  `hasToken` is therefore true for every seat, and a cross-machine rotate
  clears every installation copy, so today it is total for all of them.
- **Older bearers are still live.** 14 identities carry 1,539 bearers left
  behind by earlier `force` re-mints. None was used in the last 7 days, 5 in
  the last 30 days, and 882 never.
  - Laptop seats: `hollis` 2, `juno` 2, `piper` 2, `reed` 1 and `vale` 1, all
    five running and kept by the fleet supervisor, plus `pod-architect` 2,
    which has a token file but is not running. Each seat's 30-day uses predate
    its current attach on 2026-09-01 or 2026-09-04.
  - Cluster identities: `commonly-bot` (two instances, 514 between them), four
    `openclaw` instances (805), `newshound` (209) and `hosted-smoke` (1). All
    were last used in July or August.
- The `.bak` token files on the laptop hold the same bearer as their live
  files, so the disk carries no extra bearer.

What this means for the fixes:

- The `force` fix is the one that matters today.
- The `hasToken` fix guards a state no identity is in right now.
- Neither fix removes the 1,539 bearers already live. That takes a one-time
  sweep: remove each installation copy that is not on its User row, and revoke
  any credential row for it. Before the sweep runs, re-check that no survivor
  has been used recently.

**The ordering that never leaves a seat without a valid token.**

On the same machine (this plan):

1. Stop everything that relaunches the seat. Take it out of the fleet
   supervisor's kept list (or pause the supervisor), and `launchctl bootout`
   its seat plist if it has one. A kill or a graceful stop alone is undone by
   KeepAlive within seconds.
2. Wait for the idle boundary and stop the old runner gracefully.
3. Let the daemon adopt. It reuses the seat's token file, so the token never
   changes and is valid throughout. Rollback means restarting the old owner
   on the same file.
4. Verify one round trip. Then remove the plist and the kept-list entry for
   good.

On another machine (fleet to VM):

1. Before anything else, confirm the seat's token is on the User row. If it is
   installation-only, the rotate will not revoke it, so revoke it explicitly
   as part of the move.
2. Stop the relaunchers and the old runner, as in steps 1–2 above.
3. Bind the seat to the new machine and let its daemon rotate. The only gap is
   the adoption latency, and at no point does a runner hold an invalid token.
4. Rollback is a second rotate back to the laptop, binding and minting through
   the laptop's daemon. Never restore the laptop's token file: the rotate
   revoked it.

Never use `commonly agent attach` as a recovery step during a cutover. It
always sends `force`, which mints a second valid token and leaves the first
one working.

**Two fixes before any cross-machine move.** Neither is needed for a
same-machine cutover that follows the ordering above.

- Registry `force` re-mints should revoke the way the binding route does:
  revoke the credential rows and clear the installation copies.
- The binding route's `hasToken` gate should also count installation copies.
