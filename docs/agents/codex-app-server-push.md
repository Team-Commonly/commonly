# Pushing a Commonly mention into an open Codex session

**Status: assessed, not built.** Nothing in `@commonlyai/mcp` or the `commonly`
CLI does this yet. This page records what Codex's app-server allows, so a build
can start from tested facts. For Claude Code, the shipped path is channel mode
([MCP_INTEGRATION.md](../MCP_INTEGRATION.md#channel-mode-claude-code-research-preview)).

Codex has no MCP push: an MCP server can't start a turn in a Codex session. The
question was whether anything else can reach the session a person has open.

## What was tested

- codex-cli **0.162.1** and **0.169.0**, on macOS, tested 2026-11-13.
- Each version ran in an isolated `CODEX_HOME`, on this machine only, with no
  Commonly server involved.
- A real Codex TUI ran in a pseudo-terminal, standing in for the person's open
  session. A second process, standing in for a Commonly bridge, talked to the
  same daemon.
- Both versions gave the same protocol results in every step below. The TUI's
  rendering was checked on both, by reading its screen output after each run.

## Findings

**1. The TUI is a client of a shared local daemon.** By default `codex` runs its
threads in the local app-server daemon (`--no-daemon` opts out). When the TUI
quits, it prints "Disconnected from this task. Any running work continues." and
a `codex resume` command. The thread belongs to the daemon, so another client of
that daemon can reach it.

**2. The control socket speaks WebSocket.** The daemon listens on
`$CODEX_HOME/app-server-control/app-server-control.sock`. A client sends an HTTP
`Upgrade: websocket` request, gets `101 Switching Protocols`, then exchanges
JSON-RPC messages as text frames.
- `codex app-server proxy --sock <path>` only relays raw bytes (it's meant for
  SSH), so a client behind it still has to speak WebSocket. Plain JSON lines
  through the proxy break the pipe.
- macOS rejects a long Unix socket path (`AF_UNIX path too long`; the limit is
  104 bytes). With a deep `CODEX_HOME`, connect with a relative path from the
  socket's directory.

**3. A second client can start a turn in the person's open thread.** The
sequence:
1. `initialize` with `clientInfo` and `capabilities.experimentalApi: true`, then
   the `initialized` notification.
2. `thread/loaded/list` to find the thread. It can also list a short-lived
   thread that refuses `thread/read` with `includeTurns`, so skip any thread
   that can't be read.
3. `thread/resume` on that thread. The test always called it; whether it's
   needed wasn't checked.
4. `turn/start` with a `text` input.

The TUI showed the injected text as a new prompt and streamed Codex's answer
live. The answer to a one-line test took about 2 seconds.

**4. While the person's turn is running, `turn/start` takes it over. Never do
this.** Reading the thread during a turn returns status `{"type": "active"}`.
`turn/start` on an active thread doesn't refuse. It folds the new input into the
running turn: the person's task stopped partway, and the turn ended with the
injected message's answer. The response looks like success, with a new turn id
and status `inProgress`, so the caller can't tell from it that it took a turn
over.

**5. `thread/queue/add` waits its turn.** It needs `threadId`,
`clientUserMessageId` and `input`. The queued message ran right after the
person's turn ended, and the TUI rendered it.

A bridge should read the thread's status first, then use `turn/start` when the
thread is idle and `thread/queue/add` when it's active.

## What a build has to handle

- **Sender attribution.** The injected text shows as if the person typed it.
  The bridge has to say who wrote it in the text itself, and gate senders the
  way channel mode does. An ungated bridge lets anyone who can mention the agent
  type into the person's session.
- **Which thread.** `thread/loaded/list` returns every loaded thread on the
  daemon. The person has to choose one, for example by working directory or
  thread name.
- **Approvals.** Not tested: no injected turn asked for an approval. `turn/start`
  and `thread/resume` accept their own approval policy, so a build has to choose
  one on purpose, and check where any prompt appears.
- **Experimental surface.** `codex app-server` is marked experimental in
  `--help`, and the schema marks some `turn/start` fields experimental. The test
  always set `experimentalApi`, so it didn't check which calls need it. Re-run
  this check on each Codex version a build claims.
