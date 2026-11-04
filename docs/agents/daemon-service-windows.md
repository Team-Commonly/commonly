# The daemon on native Windows

Read of `cli/src/lib/daemon-service-windows.js`, `cli/src/lib/sandbox/windows-unsandboxed.js`
and the CI proof `.github/workflows/daemon-windows.yml` (D245, 2026-11-04). The macOS and Linux
service is described in [daemon-service-environment.md](daemon-service-environment.md); the
provider-key rules there apply here too.

## What `commonly daemon install` registers

A per-user Task Scheduler task named `CommonlyDaemon`. It needs no administrator.

| piece | where | why |
|---|---|---|
| Task definition | `%USERPROFILE%\.commonly\daemon\service\commonly-daemon-task.xml` | Registered with `schtasks /Create /XML`. Its presence is the "installed" record, like the plist and the unit file. |
| Launcher | `…\service\commonly-daemon.ps1` | Loads the service environment, then runs `node <cli> daemon run --foreground` in a loop. |
| Service environment | `…\service\service-env.json` | The provider keys the seats need (a task cannot carry environment variables). Written 0600 at creation, then its ACL is narrowed to the user with `icacls`; a refused `icacls` is warned, not fatal. |

The task:
- starts at **this user's logon** (`LogonTrigger` naming the user), runs as that user, least privilege;
- has a **one-minute repeating trigger** with `MultipleInstancesPolicy: IgnoreNew` as a watchdog: while
  the launcher runs it does nothing, and if the launcher is killed the next minute starts it again;
- has no run-time limit (`ExecutionTimeLimit PT0S`; the default is 72 hours) and no battery or idle stop.

## Keep-alive and stop codes

The launcher restarts `daemon run` 5 s after every exit, **except 77** (this computer's key was
revoked) **and 78** (no valid local registration). On those it disables the task and exits, so the
watchdog does not restart a daemon that was told to stop. These are the codes systemd's
`RestartPreventExitStatus=77 78` exempts. Task Scheduler's own "restart on failure" setting fires only
when a task fails to *start*, not when its program exits non-zero, so it cannot be the keep-alive.

Ending the task (`schtasks /End`, and so `stop`, `restart`, a reinstall and `uninstall`) terminates the
launcher only, never the node it started; on windows-latest that left a stopped task's daemon checking
in. So the launcher passes its pid in `COMMONLY_DAEMON_LAUNCHER_PID`, and the daemon polls it every 2 s
and shuts down, stopping its seats, once the launcher is gone. The launcher also sets
`[Console]::OutputEncoding` to UTF-8; Windows PowerShell 5.1 otherwise decodes node's output in the
console code page and the log reads `ΓÇö` for `—`.

| command | what it does |
|---|---|
| `commonly daemon stop` | Disables the task, then ends it. |
| `commonly daemon start` | Enables the task and runs it (also undoes a 77/78 park). |
| `commonly daemon restart` | Ends, enables, runs. |
| `commonly daemon uninstall` | Ends and deletes the task, removes its three files and the unsandboxed marker. |

## No sandbox on Windows, and the opt-in

A public seat is confined with Seatbelt on macOS and bubblewrap on Linux. Windows has neither, so by
default a Claude Code (or OpenCode, Qwen) seat is **refused** on native Windows, in the foreground
and under the daemon. The person at the keyboard can choose otherwise:

- `commonly agent run <name> --unsandboxed`: this one foreground run.
- `commonly daemon install --unsandboxed`: writes `%USERPROFILE%\.commonly\daemon\unsandboxed.json`;
  only seats the daemon spawns read it. `commonly daemon install` without the flag, or `uninstall`,
  removes it. `commonly daemon status` prints `Sandbox: unsandboxed (opted in)` while it is set.

Rules the code enforces:
- **Only a local action sets it.** Nothing the server sends (a seat's environment, an adopted-seat row,
  pod settings) creates the marker or stands in for the flag. The decision reaches the Claude adapter
  as `hostUnconfined` on its spawn context, set only by `agent run`; the environment never carries it
  (tests: `windows-unsandboxed.test.mjs`, `adapters.claude.windows-unconfined.test.mjs`).
- **Only the OS jail is skipped.** The seat keeps its trust, so the public tool policy
  (`--setting-sources ''`, `--strict-mcp-config`, `dontAsk`, `Read(./**)`, the denied tools and home
  reads, written in the `/c/Users/...` form Claude Code matches on Windows) and the sanitized child
  environment still apply. An earlier draft dropped the environment to `mode: 'none'`, which lost the
  trust and loaded the owner's own `~/.claude` settings and MCP servers; don't go back to that.
- **No shell without the jail.** On this path a workspace seat's `write` grant gives `Edit` and `Write`
  but never `Bash` or `PowerShell`: a jail-less shell would run with the user's whole access and could
  read the seat's token from its environment. A foreground `--unsandboxed` run doesn't report to the
  server (only the daemon's check-in does), so this local rule and the win32 broker withhold are what
  hold for it.
- **Claude Code only.** OpenCode and Qwen stay refused with the flag; Codex is never refused (its own
  profiles confine it) and needs no flag.
- **No seat on native Windows gets connector grants**, opted in or not: `confinementReason` returns
  `sandbox_mode_unenforceable` on win32 for every adapter.
- **The server refuses too.** A Windows check-in carries `sandbox: 'native-windows'`, or
  `'unsandboxed-opted-in'` with the marker; macOS and Linux send `'default'`. Windows never reports
  `'default'`, so a Codex daemon or a removed marker can't clear the server's refusal.
  The server stores either Windows value as `Machine.hostUnconfined`, and `judgeSeatConfinement`
  refuses grant use for every seat bound to that machine (`'default'` clears it; an older daemon that
  sends nothing leaves it as it was).
- The flag is refused on macOS and Linux. A failed install puts the marker back as it was; uninstall
  removes it even when uninstall fails partway.
- If the 77/78 park cannot disable the task, the launcher sleeps instead of exiting, so the watchdog
  doesn't restart a daemon that asked to stay down.

WSL 2 is the sandboxed route for every adapter, Claude Code included since F96: inside WSL a public
Claude Code seat runs under bubblewrap, as on any Linux host (`cli/src/lib/sandbox/host-check.js`).

## Launching Claude Code and Codex without a shell

npm installs `claude` and `codex` as `.cmd` shims, which Node will not spawn without a shell, and a
shell is not acceptable because the prompt is untrusted argv. `cli/src/lib/windows-command.js`
resolves the shim to `node.exe` plus its JS entry (or to the `.exe` it wraps) and spawns that; the
default `npx` MCP server is resolved the same way. An unresolvable shim is refused with a reason,
never run through `cmd.exe`.

npm's own `npm.cmd` and `npx.cmd` aren't cmd-shims. Before it runs npm, each one asks npm for its global
prefix (`node npm-prefix.js`, or `npm-cli.js prefix -g` on older npm) and runs the npm it finds there.
That's how an npm installed with `npm i -g npm` wins. The resolver asks the same script the same
way: `node.exe` with no shell, in the child's env, and in its folder when the caller passes one (the warm does; the MCP config render doesn't yet). It doesn't guess `%APPDATA%\npm`, which
is only the default prefix. If an npmrc or `npm_config_prefix` moves the prefix, a stale npm left in
`%APPDATA%\npm` would otherwise run in place of the one the person gets by typing `npm` (TASK-775).
No answer, or an answer that names no npm, leaves the npm bundled with Node, just as `npm.cmd` does.

**Every child the CLI spawns by name goes through that resolver, `npm` included.** The MCP warm
(`cli/src/lib/mcp-warm-child.mjs`) once spawned bare `npm`, which is `npm.cmd` on Windows. The warm
failed in milliseconds, no build was ever prepared, and every public turn was refused with
`public_mcp_unavailable`, so the page's Windows lines never answered an @mention (D164). Every unit
tier passed, because they mock the spawn. Only the windows-latest walk below caught it. A new
`spawn('<name>', …)` needs `resolveLaunch` (or a Windows test that runs it). `commonly dev`'s
`npm test` is still bare, and it isn't on a seat path. A spawn with its own `cwd` passes that `cwd`
to the resolver too: a relative PATH entry such as `.` is read in the child's folder, as Windows reads
it, not in the folder the CLI was started from, where a planted `npm.cmd` would run with the agent
token in its env.

## What is proven, and what is not

- **CI (`daemon-windows.yml`, windows-latest):** install registers the task; the daemon checks in to a
  stub API; killing the daemon process brings it back; killing the launcher too brings it back
  through the watchdog; killing only the launcher takes its daemon with it; every install and restart
  leaves exactly one daemon; the opt-in reaches the check-in and a plain install removes it; stop stays
  stopped through a watchdog interval; uninstall leaves nothing behind.
- **CI (`byo-windows.yml`, windows-latest, D164):** the Bring your own page's four PowerShell lines
  for Claude Code, lifted from `V2AgentBYO.tsx`, run in one PowerShell window against a stub Commonly
  API with one @mention queued. Real Claude Code takes the turn and the reply comes back with the
  @mention acknowledged, from a fresh profile, so the MCP warm and the public-seat gate run too.
  The model is a stub, named in Claude Code's machine-wide managed settings, because a public seat
  strips `ANTHROPIC_*` from Claude Code's env. Two legs: the published CLI and this checkout's packed
  CLI. A guard after the install line stops the paste when npm fails, so a failed install never falls
  through to a `commonly` already on PATH. On a pull request, what the published CLI does once it
  holds the @mention only warns, because a CLI fix reaches npm after it merges. A published install
  that fails, or a published CLI that never picks up the @mention, still fails the PR: this tree's
  leg replaces the page's install line, so only the published leg proves it
  (`cli/scripts/windows-byo-verdict.mjs`).
- **Not proven:** a turn on a signed-in Claude Code account (the walk's model is a stub), a tool call
  from the model through the commonly MCP server on Windows (the stub answers in text), and Codex on
  Windows at all. The BYO page says Codex is untested on Windows.
