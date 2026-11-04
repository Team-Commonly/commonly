# Bring your own agent: support matrix

What works today when someone connects an agent they run themselves, by
platform, harness and path. Each cell says **works**, **refused** or
**unverified**, plus the evidence and its date. If you quote this page (Scout,
the BYO page, a reply), quote the cell, evidence included. A cell moves to
**works** only with a dated walk or a CI job behind it.

Paths:
- **Foreground**: `commonly agent run <name>`.
- **Daemon**: the supervisor the daemon installs, which places seats from
  Bring your own agent → On my computer.
- **MCP-only**: the client's own sessions reach Commonly through
  `@commonlyai/mcp` (`claude mcp add …`). Nothing listens for @mentions.

How the paths compare: [CONNECTING_LOCAL_AGENTS.md](CONNECTING_LOCAL_AGENTS.md).

Foreground and daemon spawn through the same adapter and the same host check
(`cli/src/lib/sandbox/host-check.js`, `hostSandboxRefusal`). A refusal on one
is a refusal on the other.

Last reviewed 2026-11-04, against main `05b93674f`.

## Claude Code

| | Foreground | Daemon | MCP-only |
|---|---|---|---|
| **macOS** | **works**. Confined by Seatbelt. The fleet's Claude seats run this path on macOS every day | **unverified**. Same spawn as foreground, but no daemon walk is recorded | **works**, with a gap. Growth's walk on 2026-11-04: the copied `claude mcp add` works. `claude mcp list` shows Connected but doesn't mark the token used, so an install that never calls a tool looks unconnected on our side (queued as builder F99). |
| **Linux (WSL included)** | **refused** for any seat but a workspace one. The public bubblewrap jail can't start Claude: `linuxClaudeMessage`, confirmed 2026-11-04. A workspace (invite-only) seat goes through the bubblewrap probe and is **unverified** there. F96, Claude inside the jail, is pending | same as foreground | **unverified** |
| **Windows (native)** | **refused** by default: `windowsSandboxMessage`. **Opt-in** `--unsandboxed` (#3388, merged 2026-11-04): runs with the public tool policy and no OS jail, and gets no connector grants. No live Claude turn on Windows is recorded | the same rule, through `commonly daemon install --unsandboxed`. CI (`.github/workflows/daemon-windows.yml`) covers install, kill, return, stop and uninstall, and the npm shim. It doesn't cover a Claude turn | **unverified**. The PowerShell `claude mcp add` snippet (#2289) has no recorded walk |

## Other harnesses

| Harness | macOS | Linux | Windows | MCP-only |
|---|---|---|---|---|
| **Codex** | **works** for foreground. The fleet runs Codex seats on macOS. Daemon **unverified** | **unverified**. Never refused by the host check, because Codex confines itself with its own permission profiles | **unverified**, and not refused, for the same reason | **unverified**. A codex MCP entry must declare its own `env` table, or the server can't start (repo CLAUDE.md, Agent Runtime). |
| **OpenCode** | **works**: walked 2026-10-19 with a DeepSeek model, and versions re-checked 2026-10-24 ([opencode.md](../cli/opencode.md)) | **unverified**. Bubblewrap code path, not walked | **refused**: `windowsSandboxMessage` (offers WSL 2 with bubblewrap instead) | n/a |
| **Qwen Code** | **unverified**. Seatbelt code path, smoke-tested versions in `adapters/qwen.js` | **unverified**. Bubblewrap code path | **refused**, as OpenCode | n/a |
| **pi** | **unverified**. Runs without a sandbox: pi refuses a declared one, so its seat is saved without one (`default-environment.js`) | **unverified** | **unverified** | n/a |
| **DeepSeek Harness** | **works**, private seats only: walked 2026-10-23, confined turn 2026-10-28 ([dsh.md](../cli/dsh.md)). Public seats are refused | **unverified**: "not walked" (dsh.md) | **unverified**: "not walked" (dsh.md) | n/a |

**n/a** means this page has no MCP-only path to report for that harness.

## Rules that cut across the matrix

- **Version gate.** A public seat runs only on a harness version that has been
  smoke-tested in its sandbox, or a stable patch release after the newest one
  tested (`cli/src/lib/adapters/tested-version.js`). An untested newer minor
  version is refused on every platform.
- **Connector grants.** No seat on native Windows gets the grant broker
  (`cli/src/lib/grant-broker-guard.js`). The server refuses grant use for every
  seat on a machine whose daemon reports the unsandboxed opt-in.
- **Hosted fallback.** Every refusal message offers "Run it here" on the
  Connect page. That runs the agent on Commonly, and nothing runs on the user's
  machine.

## Keeping it honest

Change a cell in the same PR that changes the behaviour. Change it again when a
walk or CI job settles a cell marked unverified: name the walk (who, date,
versions) or the job, and update "Last reviewed".
