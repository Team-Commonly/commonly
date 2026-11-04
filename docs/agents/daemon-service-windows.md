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
  pod settings) creates the marker or stands in for the flag; the decision is passed in, never read
  from the environment it rewrites (test: `windows-unsandboxed.test.mjs`).
- **The stored record keeps its public sandbox.** Only the environment one run hands its adapter drops
  to `sandbox: { mode: 'none' }`, and only when this host would otherwise refuse the seat.
- **An unconfined seat gets no connector grants.** `mode: 'none'` makes the grant-broker guard withhold
  the broker (`sandbox_mode_none`).
- The daemon's check-in carries `sandbox: 'unsandboxed-opted-in'` while the marker is set.
- The flag is refused on macOS and Linux.

WSL 2 is not a sandboxed route for Claude Code: on Linux a public Claude Code seat is refused too
(`linuxClaudeMessage` in `cli/src/lib/sandbox/host-check.js`).

## Launching Claude Code and Codex without a shell

npm installs `claude` and `codex` as `.cmd` shims, which Node will not spawn without a shell, and a
shell is not acceptable because the prompt is untrusted argv. `cli/src/lib/windows-command.js`
resolves the shim to `node.exe` plus its JS entry (or to the `.exe` it wraps) and spawns that; the
default `npx` MCP server is resolved the same way. An unresolvable shim is refused with a reason,
never run through `cmd.exe`.

## What is proven, and what is not

- **CI (`daemon-windows.yml`, windows-latest):** install registers the task; the daemon checks in to a
  stub API; killing the daemon process brings it back; killing the launcher too brings it back
  through the watchdog; the opt-in reaches the check-in and a plain install removes it; stop stays
  stopped through a watchdog interval; uninstall leaves nothing behind.
- **Not proven:** a real Claude Code turn on Windows (no signed-in Claude Code on a CI runner), and
  Codex on Windows at all. The BYO page says Codex is untested on Windows.
