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
is a refusal on the other. The host check applies only to a seat that declares
a confined trust. Public seats do by default (`COMMONLY_DEFAULT_SANDBOX`), so
"refused" below means a public seat.

Last reviewed 2026-11-04, against main `05b93674f`.

## Claude Code

| | Foreground | Daemon | MCP-only |
|---|---|---|---|
| **macOS** | **unverified** for a public seat. Its Seatbelt code path is the default. The team runs Claude seats on macOS, but no dated public-trust walk is recorded | **unverified**. Same spawn as foreground, but no daemon walk is recorded | **works**, with a gap. Growth's walk on 2026-11-04: the copied `claude mcp add` works. `claude mcp list` shows Connected but doesn't mark the token used, so an install that never calls a tool looks unconnected on our side (a fix is queued). |
| **Linux (WSL included)** | **refused** for any seat but a workspace one. The public bubblewrap jail can't start Claude: `linuxClaudeMessage`, confirmed 2026-11-04. A workspace (invite-only) seat goes through the bubblewrap probe and is **unverified** there. Running Claude inside the jail is approved and not built yet | same as foreground | **unverified** |
| **Windows (native)** | **refused** by default: `windowsSandboxMessage`. **Opt-in** `--unsandboxed` (#3388, merged 2026-11-04): runs with the public tool policy and no OS jail, and gets no connector grants. No live Claude turn on Windows is recorded | the same rule, through `commonly daemon install --unsandboxed`. CI (`.github/workflows/daemon-windows.yml`) covers install, kill, return, stop and uninstall, and the npm shim. It doesn't cover a Claude turn | **unverified**. The PowerShell `claude mcp add` snippet (#2289) has no recorded walk |

## Other harnesses

| Harness | macOS | Linux | Windows | MCP-only |
|---|---|---|---|---|
| **Codex** | **unverified**. The team runs Codex seats on macOS, but no dated public-trust walk is recorded | **unverified**. Never refused by the host check, because Codex confines itself with its own permission profiles | **unverified**, and not refused, for the same reason | **unverified**. A codex MCP entry must declare its own `env` table, or the server can't start (repo CLAUDE.md, Agent Runtime). |
| **OpenCode** | **works** on a tested version. Walked 2026-10-19 on 1.19.3 with a DeepSeek model. A replay fixture covered 1.18.35, 1.19.0 and 1.19.4 on 2026-10-24 ([opencode.md](../cli/opencode.md)). 1.19.3 is not on the tested list, so a public seat on it is now refused | **unverified**. Bubblewrap code path, not walked | **refused**: `windowsSandboxMessage` (offers WSL 2 with bubblewrap instead) | n/a |
| **Qwen Code** | **unverified**. Seatbelt code path, smoke-tested versions in `adapters/qwen.js` | **unverified**. Bubblewrap code path | **refused**, as OpenCode | n/a |
| **Goose** | **unverified**. Seatbelt code path for explicitly configured public confinement; version gate `TESTED_GOOSE_VERSIONS` (`adapters/goose.js`) | **unverified**. Bubblewrap code path | **unverified** | n/a |
| **pi** | **unverified**. Runs without a sandbox: pi refuses a declared one, so its seat is saved without one (`default-environment.js`) | **unverified** | **unverified** | n/a |
| **DeepSeek Harness** | **works**, private seats only: walked 2026-10-23, confined turn 2026-10-28 ([dsh.md](../cli/dsh.md)). Public seats are refused | **unverified**: "not walked" (dsh.md) | **unverified**: "not walked" (dsh.md) | n/a |

**n/a** means this page has no MCP-only path to report for that harness.

## Rules that cut across the matrix

- **Version gates differ by harness.**
  - OpenCode and Qwen public seats run only on a smoke-tested version, or a
    stable patch after the newest tested one on the same line
    (`cli/src/lib/adapters/tested-version.js`). The host can override this with
    `COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION` or `…_QWEN_…`.
  - DeepSeek Harness accepts one exact version on every seat.
  - Goose refuses an untested version on public seats.
  - Claude Code and Codex have no version gate.
- **Connector grants.** No seat on native Windows gets the grant broker
  (`cli/src/lib/grant-broker-guard.js`). The server refuses grant use for every
  seat on a machine whose daemon reports native Windows, with or without the
  opt-in (`backend/services/machineService.ts`).
- **Hosted fallback.** The Windows and Linux-Claude refusals offer "Run it here" on the
  Connect page. That runs the agent on Commonly, and nothing runs on the user's
  machine.

## Keeping it honest

Change a cell in the same PR that changes the behaviour. Change it again when a
walk or CI job settles a cell marked unverified: name the walk (who, date,
versions) or the job, and update "Last reviewed".
