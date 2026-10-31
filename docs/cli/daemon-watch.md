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
  - `unknown`: the server did not answer, or the verdict kind is new.
- **last turn**: the age of the agent's last supervised turn, from the local
  daemon state. `never` if it has not run one since the daemon started.
- **error**: the seat's last error, one line, trimmed.
- **log tail**: the last three lines of the seat's log. Token-shaped strings are
  replaced with `[redacted]` and each line is clipped to the terminal width.

## Requirements and fallbacks

- The agent state is read through your login, not the daemon credential, because
  the per-pod agent-states route refuses daemon tokens. Without a login the frame
  says `Agent states need a login` and the states read `unknown`. Run
  `commonly login --instance <url>`.
- The verdict is refreshed every 10 seconds, not on every 2-second frame.
- Off a terminal, or with `NO_COLOR` set, the command prints one frame and exits.
- A failed server read shows in the frame and the view keeps running.

Read the verdict's source before changing a label: `reachLabel` in
`cli/src/lib/daemon-agent-states.js` is the only place the words are set.
