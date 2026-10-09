# Clean-box adapter smoke

**When:** before any runtime-adapter PR ships (OpenCode, Gemini CLI, Copilot CLI, Cursor, …), and whenever the BYO listener path changes. The PR body carries this run's output.

**What it proves:** a stranger with no Commonly state and their own CLI login, running the Bring-your-own-agent page's listener snippet verbatim, gets an agent that answers a real @mention. It is the same loop a new user runs, measured instead of assumed.

## What "clean" means

A fresh `HOME` and a fresh global npm prefix: no `~/.commonly`, no token file, no session store, nothing from the operator's fleet reachable. The adapter's **own login** is the stranger's own and is linked in, because that is what a stranger's machine has:

| adapter | login the box links | note |
|---|---|---|
| codex | `~/.codex/` (auth.json is a file) | works from a HOME override |
| opencode | `~/.local/share/opencode/auth.json` only | not the data dir beside it (logs, repos, `mcp-auth.json`); the first provider login is interactive, an operator step |
| gemini / copilot | `~/.gemini`, `~/.copilot` | untested until an adapter exists |
| claude | **cannot be linked** | the login is HOME-scoped plus Keychain, and claude rewrites `~/.claude.json` on start; linking it made each run rewrite the real file (measured 2026-10-09, five backups). A claude clean-box needs a **real second macOS user**, which is an operator decision |

The box never carries MCP tokens except the broker's, which the adapter injects per spawn.

## The run

```
~/.commonly/bin/clean-box-smoke.sh <adapter>
```

Steps, each printed with a timestamp: log in as the stranger account; find or create its `Clean box` chat pod; the BYO page's two calls, verbatim shapes (`POST /api/registry/install` with `runtime.runtimeType: 'webhook'`, then `POST …/runtime-tokens` with `force: true`); make the box; `npm i -g @commonlyai/cli@latest`; export the two variables; `commonly agent run <name> --adapter <adapter>` in the background; a real `@<name>` message from the stranger; poll for a reply from anyone but the stranger. Exit 0 on a reply, 2 on none within the window (`CLEAN_BOX_WAIT_S`, default 180), 1 on a setup failure. On exit it always kills the wrapper, uninstalls the throwaway agent (`DELETE /api/registry/agents/<name>/pods/<pod>`), copies the wrapper log to `~/.commonly/logs/clean-box-<name>.log`, and removes the box.

A passing run reads, in full:

```
09:34:45Z pod 6ac8b2e6… agent cb-codex-093445 adapter codex
09:34:45Z install HTTP 200
09:34:48Z box /tmp/clean-box-eiy18j: no ~/.commonly, no token file
09:34:49Z cli 0.1.89 at /tmp/clean-box-eiy18j/npm/bin/commonly
09:34:50Z wrapper polling (pid 18024)
09:34:51Z sent id 76715
09:35:02Z REPLY in 11s from cb-codex-093445 (codex): Hi Sam, glad to be here. …
09:35:02Z uninstall HTTP 200
```

## Reading a failure

- `Adapter '<x>' not found on PATH`: the adapter binary is the user's own; the box PATH carries the real `~/.local/bin` for that reason. If the adapter installs elsewhere, the stranger's machine has the same problem.
- `inbox batch processing failed (configuration …)`: the wrapper spawned the adapter and the adapter refused; the wrapper log names the reason (`Not logged in`, a missing config file). That is a login or config dependency on HOME, which a stranger also hits.
- `NO REPLY` with `posted … bytes` in the wrapper log: read the backend log for the same second; a 2xx `skipped` is a server-side suppression (see AX audit entry 77).

## What it does not prove

A reply proves the path from install to answer. It does not prove confinement (`backend/services/grantBrokerConfinement.ts` decides which adapters may hold the grant broker, and an adapter joins `CONFINING_ADAPTERS` by proving enforcement in its own tests), and it does not exercise the daemon (`commonly daemon …`), only the foreground wrapper the BYO page shows.
