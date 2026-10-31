# `commonly daemon status --watch`

A live view of this machine and each agent it supervises. It redraws in place
every 2 seconds until Ctrl-C.

```
Sam MacBook: online
last heartbeat 10s ago

dart  running  last turn 2m ago
  [log tail, dimmed]
nova  not connected  last turn 3h ago
  error: child exited with code 1
```

## What each line means

- **Machine**: the registered name and server liveness, with the age of the last
  heartbeat.
- **Agent state** is the server's verdict, the same one the Your Team row uses
  (`deriveAgentState`, `backend/services/agentStateService.ts`):
  - `running`: the agent is listening (`listening`, or a native or push-webhook
    runtime, `reachable`).
  - `stalled`: it was reachable and has gone dark (`gone-dark`).
  - `not connected`: it has never polled (`never-connected`).
  - `not registered`: this machine supervises the agent, but no pod this login
    can see has it installed.
  - `unknown`: the verdict kind is new.
  - `local running`, `local stopped`, `local crashed`: no server verdict is
    available (no login, or the read failed). This is the supervisor's process
    state, and the header says why.
- **last turn**: the age of the agent's most recent turn in its session store
  (the record `commonly agent list` reads). `never` if there is none. The
  supervisor's own spawn time is not used, because it is not a turn.
- **error**: the seat's last error, one line, trimmed.
- **log tail**: the last three lines of the seat's log. Token-shaped strings are
  replaced with `[redacted]` and each line is clipped to the terminal width.

## Requirements and fallbacks

- The agent state is read through your login, not the daemon credential, because
  the per-pod agent-states route refuses daemon tokens. Each agent's pod comes
  from its token record in `~/.commonly/tokens/`.
- Without a login the header says `Not logged in: showing local process state
  only`, and the states read `local <state>`. Run `commonly login --instance <url>`.
- The verdict is cached per pod for 10 seconds, not re-read on every 2-second frame.
- An agent with no token record on this machine reads `not registered`.
- Off a terminal, or with `NO_COLOR` set, the command prints one frame and exits.
- A failed server read shows in the header, with the local state in its place,
  and the view keeps running.

The server words are set in one place: `reachLabel` in
`cli/src/lib/daemon-agent-states.js`. Change a label there, not in the renderer.
