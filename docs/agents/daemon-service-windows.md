# The daemon on native Windows

Read of `cli/src/lib/daemon-service-windows.js`, `cli/src/lib/sandbox/windows-unsandboxed.js`
and the CI proof `.github/workflows/daemon-windows.yml` (2026-11-04). The macOS and Linux
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

**Exit 79: another daemon already runs for this computer.** The launcher sleeps 30 s and tries again.
It never disables the task or exits for 79, so the task stays running and takes over once the other
copy dies. See *One daemon per computer* below.

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

## One daemon per computer (F637)

One Windows 10 machine on CLI 0.1.390 ran ~140 copies of `daemon run` on one machine key, one more
each minute, and the server's limiter rejected ~5 requests a second on each daemon route. Nothing
refused a second copy. A launcher that died while its node survived left that node running, and the
watchdog started a new launcher a minute later. An orphan also outlived its watch because `EPERM`
on the launcher's (reused) pid counted as alive, and its dead stdout pipe was swallowed silently.

- **The lock.** `daemon run` takes a lock after its stop-marker and record checks and before its first
  request (`cli/src/lib/daemon-lock.js`). It is a listening local socket the OS frees when the
  process dies, never a pid file: the named pipe `\\.\pipe\commonly-daemon-<id>` on Windows, the unix
  socket `~/.commonly/daemon/daemon-<id>.sock` elsewhere, where `<id>` is the first 16 hex of
  `sha256(home)`. It is keyed by the home alone because a home holds one machine record and
  `run --instance` refuses any other instance, so an old daemon still running across a
  `daemon register` blocks the new one. On POSIX a socket file nobody answers on is stale and is
  reclaimed. The holder answers a connection with `{"pid":<n>}` and hangs up.
- **Refused.** A daemon that can't take the lock retries for ~10 s (a restart's old node exits within
  ~2 s of its launcher), then logs one line naming the holder's pid and the machine and **exits 79**.
  It has made no request. Under launchd and systemd a 79 restarts like any other failure.
- **The watch.** Under the launcher, `EPERM` on the launcher's pid now counts as gone (the launcher is
  the same user at least privilege, so `EPERM` means the pid was reused), and an `EPIPE` or a write
  to a destroyed stdout/stderr stops the daemon through the same path, once.
- **429.** The CLI keeps a 429's `Retry-After` on the error (`err.retryAfterMs`); the supervisor then
  holds both its work-list poll and its heartbeat off for `max(Retry-After, 60 s)`, capped at 10
  minutes, and logs
  once per stretch of 429s that more than one daemon may be running. `express-rate-limit` already
  sends `Retry-After` on both daemon-route limiters.
- **What old CLIs see.** The 429 on the heartbeat and on `GET /api/agent-binding/assigned` carries an
  `error` field (old CLIs print `error` before `message`) telling the user to update the CLI and run
  `npx @commonlyai/cli@latest daemon setup` (see the opt-in note below); other routes under the same
  limiters are unchanged.
- **`DAEMON_MIN_CLI_VERSION_WIN32`** (server env, unset by default). When set, `POST /api/machines`
  refuses with 400 a registration whose host says `win32` with a CLI below it, or with no valid
  version. That is the path an old daemon takes back after its key is revoked. Set it only once a
  fixed CLI has published.
- **Clearing leftover copies.** Old copies hold no lock, and `daemon setup` doesn't remove them:
  `schtasks /End` ends the task's launcher only, never a `node` it started, and an old copy whose
  launcher watch already failed keeps running beside the new daemon. The simple fix is a reboot,
  then `npx @commonlyai/cli@latest daemon setup`. Without a reboot, go in this order, because the
  launcher restarts `daemon run` about 5 s after it exits while the task runs:
  1. `schtasks /Change /TN CommonlyDaemon /DISABLE`, so the one-minute watchdog can't start it again;
  2. `schtasks /End /TN CommonlyDaemon`, which ends the launcher;
  3. end every leftover `node` process running `commonly daemon run` (Task Manager, Details tab,
     with the Command line column on);
  4. `npx @commonlyai/cli@latest daemon setup`. Its install step recreates the task from its
     definition (`schtasks /Create … /F`, enabled) and runs it.
- **Setup turns off an unsandboxed opt-in.** Wherever this guide says to run `daemon setup`: if you
  had turned on running without a sandbox, setup turns it off, and prints "Turned off running without
  a sandbox: on Windows, agents this daemon runs are refused again until you choose otherwise." To
  keep it, add `--unsandboxed` (`npx @commonlyai/cli@latest daemon setup --unsandboxed`): agents
  this daemon runs then have no sandbox; they act with your own access to files and commands, and get
  no connector grants. See the opt-in section below.

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
- **A host that hasn't reported is refused, never read as confined (F356).** The daemon adopts seats
  in `tick()` before its first heartbeat, so a new Windows machine used to read as confined for those
  first seconds. Each report now stamps `Machine.hostSandboxReportedAt`; until it does,
  `judgeSeatConfinement` refuses with `sandbox_not_reported` (`hostUnreported`), and the grant form
  says the computer hasn't reported yet. A daemon older than #3388 never reports, so its seats get no
  grants until its CLI is updated.
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
`public_mcp_unavailable`, so the page's Windows lines never answered an @mention. Every unit
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
- **CI (`byo-windows.yml`, windows-latest):** the Bring your own page's four PowerShell lines
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
  (`cli/scripts/windows-byo-verdict.mjs`). Dispatched on main once #3437 merged, both legs passed,
  the published one on `@commonlyai/cli` 0.1.243 (2026-11-04, run 41921620690).
- **Prod walk (`byo-windows.yml`, `target=prod`):** the same four lines against commonly.me,
  as a real agent in an invite-only pod, with Claude Code on `claude-haiku-5-5` through the model
  gateway. The run waits at `READY: listening in <podId>` for a person to post the @mention, then
  passes on the agent's reply plus the CLI's ack of that mention's event, read from a fetch observer
  loaded into the CLI (`cli/scripts/windows-byo-ack-recorder.mjs`), because the server has no read
  of an event's state that doesn't also claim it. Run 41926949969 (2026-11-04) passed on the
  published CLI 0.1.245: reply in 16 s, ack HTTP 200. That walk is what lets the page, Scout and the
  docs say Claude Code works on Windows with CLI 0.1.243 or newer.
  - **Post the @mention within 10 minutes of READY, and after it.** READY came about 50 s after
    dispatch, and the walk counts only a mention posted after READY, until 10 minutes later. The
    `READY` notice doesn't show in the run's annotations while the job runs, so don't wait for it:
    post a few minutes after you dispatch. On 2026-11-14 a mention that arrived a few seconds after
    the window closed failed the walk (run 43532513343).
  - **Pick the Codex version with `codex_version`** (default `0.169.0`, what npm gives today). The
    walk names the gateway key's one model in Codex's system config, because a BYO seat keeps
    Codex's own default model. Left to that default, 0.169.0 asked for `gpt-6.1-sol`, and the key
    refused it with a 403 (run 43533845911).
- **Not proven:** a turn on a signed-in Claude Code account (the stub walk's model is a stub, and the
  prod walk reaches its model with a gateway key), and a tool call from the model through the commonly
  MCP server on Windows (neither walk's turn calls a tool). Codex on Windows has its own walks, in
  a private pod through a listener, recorded in `byo-support-matrix.md`.
