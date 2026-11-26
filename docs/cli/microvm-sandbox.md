# The microVM sandbox on native Windows (opt-in)

Native Windows has neither Seatbelt nor bubblewrap, so a confined Claude seat
there used to have two choices: refuse, or run without an OS sandbox by the
person's own `--unsandboxed`. A public Codex seat could only refuse. This mode
adds another way for both. Each turn runs inside a
[microsandbox](https://github.com/superradcompany/microsandbox) microVM that
boots through the Windows Hypervisor Platform (WHP).

It is **off by default**. Running unconfined by choice stays the default on
Windows until a real Windows desktop walk passes. Evidence for the design is in
[`docs/plans/microsandbox-windows-spike.md`](../plans/microsandbox-windows-spike.md).

## Turning it on

1. Turn on WHP once, from PowerShell run as Administrator, then reboot:

   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
   ```

   WHP is `HypervisorPlatform`, not `VirtualMachinePlatform`, which WSL uses.
2. Set `COMMONLY_SANDBOX_MICROVM=1` in the environment that runs the CLI (the
   `agent run` shell, or the daemon's).
3. Give the agent a provider key: `ANTHROPIC_API_KEY` for Claude, `CODEX_API_KEY`
   (or `OPENAI_API_KEY`) for Codex. The key stays on the host, and the VM gets a
   per-turn proxy token instead. A subscription login (Claude's, or a ChatGPT
   sign-in for Codex) has no way into the VM.

A Claude public or workspace seat with no declared `sandbox.mode` then resolves
to `microvm` on that host. A public Codex seat does too, whatever mode it
declared (see [Codex](#codex)). The first turn downloads msb (about 30 MB) and
installs the agent into a disk volume. Later turns boot in a couple of seconds.

## What holds

| | How |
|---|---|
| Mode | Host-resolved in `sandbox/mode.js`, the only reader of the flag. It is never stored: an environment file that names `microvm` fails validation. |
| Adapters | Claude (public and workspace trust) and Codex (public trust). Attach and the run-time host check allow those two and refuse every other adapter. |
| Fail closed | The claude and codex adapters check the platform, the flag, WHP and msb at every spawn. A missing piece refuses the turn; nothing falls through to a bare spawn, or to Codex's own Windows sandbox. |
| Network | `--no-net`, then `allow@dns` and `allow@host:tcp:<port>` for exactly two ports: the provider proxy and the MCP bridge. There is never a whole-group `allow@host`, which reaches every service on the host's loopback. There is never a `--net-rule` without `--no-net` either, since that keeps the public internet open. |
| Credentials | The provider key stays in the host proxy (Anthropic's wire for Claude, the OpenAI Responses wire for Codex). The Commonly MCP server, and with it the agent's runtime token, run on the host behind the bridge. The guest's shim must send the turn's secret first. The bridge caps live sessions, and starts each server in the workspace folder with the seat's withheld tools in `COMMONLY_MCP_WITHHELD_TOOLS`, so a server that runs outside the agent's own tool policy still withholds them itself. |
| Files | The turn folder and the workspace are always read-only, so the project's `.git` (hooks, config) is never the guest's to write. A workspace seat with `sandbox.allow` grants (`write`, `web`) is refused for now. The seat's own HOME lives under `%LOCALAPPDATA%\commonly\microsandbox\<version>\seats`, one per trust. Argv and env go through a turn file, never the msb command line. |
| Install volume | Claude Code and Codex live on the `commonly-agents` disk volume, each installed the first time a seat of that adapter runs. It is mounted writable only for the one-time install, under a lock so two first turns never install at once; every turn mounts it read-only. The lock names the process holding it, and another turn takes it over once that process has exited, so a slow install is not cut in on; after an hour it is taken over regardless, so a leaked lock can't wedge installs. The msb download has a 5-minute deadline, so a stalled connection can't hold the lock. |
| msb | Pinned to v0.8.1 and checked against the release's SHA-256. It goes to `%LOCALAPPDATA%\commonly\microsandbox\0.8.1`, never through an install script and never globally, and the installed `msb.exe` is hashed again before every use. Moving the pin is a reviewed change, with the Windows workflow run on the new version. |
| Guest | `node:22-bookworm-slim`, pinned by digest, with Claude Code `2.1.331` and Codex `0.172.0` (`@openai/codex`) on the `commonly-agents` volume. |

`--unsandboxed` still means what it did: the person's own choice to run a
Claude seat without an OS sandbox wins over the flag. For Codex it still
reaches only a seat whose every pod is confirmed private, which then runs with
no public trust and so never resolves to the microVM.

## Codex

A public Codex seat runs in the VM the way a Claude seat does: the same fence,
the same bridge, the same read-only mounts and seat HOME, and the same refusals.
What differs is below.

**How a seat lands in `microvm`.** Codex's `sandbox.mode` is not a host
mechanism. `workspace` and `read-only` choose write or read access inside Codex's
own permission profile, which is why Codex resolves no Seatbelt or bwrap mode
(`mode.js`). So on win32 with the flag on, a public Codex seat resolves to
`microvm` whatever it declared (`resolveCodexSandboxMode`). We picked the safer
reading of a declared mode. The only other confinement on that host is Codex's
own Windows sandbox, which can't enforce a public profile's read denies, so
reading `workspace` as "use Codex's sandbox" would hand the seat to a sandbox
that refuses it. Reading it as `microvm` can only narrow the seat: the workspace
mounts read-only, so a seat that declared `workspace` runs as `read-only`. Its
file edits fail inside the VM. With the flag off, nothing about Codex moves on
any platform, and `microvm` is never stored: an environment file naming it still
fails validation.

**The model.** The host proxy holds `CODEX_API_KEY` (or `OPENAI_API_KEY`) and
forwards to `OPENAI_BASE_URL`, or to OpenAI when that is unset. Inside the
guest, Codex gets a `model_providers.commonly_proxy` entry whose `base_url` is
the proxy's guest address and whose `env_key` names a variable holding the
per-turn token. This is the provider-proxy route a public Codex seat already
takes on macOS and Linux, pointed at `host.microsandbox.internal`. A ChatGPT
sign-in has no way into the VM, so a seat with only that is refused with a line
that says so.

**MCP.** The Commonly MCP server runs on the host behind the bridge, started
with the seat token as a file path and the public seat's withheld tools in
`COMMONLY_MCP_WITHHELD_TOOLS`. The guest's Codex gets each entry in a
`config.toml` that the host writes into its Codex home before the turn and
removes after it (after a killed turn, the next turn's prepare removes it). The
turn secret is also redacted from any failure msb or Codex prints. Each entry has the guest shim as its command, Codex's
`disabled_tools` for the same withheld list, and an `env` table with the bridge
address and the turn secret. Codex passes its MCP children none of its own
environment, so without the table the shim couldn't find the bridge and the
tools would never appear. The entries live in that file, not in `-c` overrides,
so the turn secret stays out of Codex's argv, which any process in the guest can
read through `/proc/<pid>/cmdline`. The turn folder's `mcp.json` carries no
server and no secret for a Codex turn. Any other declared server, and any HTTP server,
including the grant broker, is refused, as for Claude.

**What Codex runs with inside the VM.** It runs under its own public permission
profile, `read-only`, with the network off, just as on macOS and Linux. It is
never given `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`.
The VM is the fence that holds against the host. The profile is a second layer
inside it, guarding the one thing the VM leaves writable, the seat HOME, which
keeps Codex's sessions and from which Codex loads `AGENTS.md` and skills. Which
layer stops what, for the model's shell (measured by the Windows smoke, step 4b):

| What the shell tries | Stopped by |
| --- | --- |
| Writing the workspace | The read-only mount, and the profile (no writable root) |
| Reaching the network | The VM's fence (`--no-net` plus the two host ports), and the profile |
| Reading `config.toml` (the bridge secret) or anything else in the Codex home | The profile's reads. Codex's Linux sandbox (bwrap) starts from an empty `tmpfs /` and binds in, read-only, only the system's minimal set, the workspace, Codex's arg0 helper folder and the agents volume |
| Writing the Codex home or the seat HOME | The profile's writes, by the same means. The shell's view of `/home/seat/codex-home` is that private tmpfs, so a write there appears to succeed but lands in memory and is gone when the command exits. It never reaches the seat HOME |

Codex itself runs outside bwrap and writes its home (sessions, memories, logs,
state databases), so the host clears that home to an allowlist before every
turn (below). What the profile does not hide is `/proc`: if a later change put
the secret back in argv, the model's shell could read it there. The turn folder
holds the per-turn proxy token, which reaches only the proxy and only for this
turn. Codex's sandbox runs in the guest, since the guest kernel allows user
namespaces. If a later Codex or guest image can't start it, shell commands fail
and the turn reports it. Nothing falls back to full access. The guest's Codex
home is `/home/seat/codex-home`, not `~/.codex`, because the profile denies
`~/.codex` whole and the arg0 helper lives in the Codex home.

**Nothing in the Codex home but the seat's sessions persists into the next
turn.** Before every turn the host removes every entry of the Codex home except
two, then rewrites `AGENTS.md` from the seat's declared skills and writes the
turn's own `config.toml`. What stays:
- `sessions/`, the seat's rollouts. `codex exec resume <id>` finds a thread by
  scanning this folder's file names when its state database has no row, and
  that database is removed with the rest.
- `tmp/arg0-linux/`, where Codex links its own binary under helper names at
  each launch, puts only that launch's folder on `PATH`, and prunes stale ones.
  Its entries are links by design. The host never reads, stats or removes
  anything inside it, and the model's shell sees it read-only, so it can't
  plant a helper there. Everything else in `tmp/` is removed.

So a file left anywhere else (`AGENTS.override.md`, a hooks or environments
file, `skills/`, `memories/`, `history.jsonl`, `log/`, or an extension point a
later Codex adds) never reaches the next turn. A link in the Codex home outside
the two kept folders, or in place of either one, refuses the turn until it is
removed. Links inside `sessions/` are left there and never followed. Codex runs with
`--ignore-rules`. It does not run with `--ignore-user-config`, since it reads
that host-written `config.toml`; every other setting rides in `-c` overrides,
which win over the file.

**No host operation follows a link in the seat HOME.** The HOME is the guest's to
write, so a turn could leave a symbolic link or a Windows junction where a
folder or file belongs. Every host write, removal, folder creation and read
under it goes through `sandbox/guest-home.js`. Each path component is checked
with `lstat` and a link is refused, never followed or removed. Folders are made
one level at a time. Files are written to a randomly named staged file, created
exclusively (with `O_NOFOLLOW` where the platform has it), then renamed over the
target. A refusal names the path; remove the link and run the turn again.

**The host touches the seat HOME only when no VM of the seat is running.** The
checks above stop working if a guest can swap a folder for a link between the
host's check and its action, so they need the HOME unmounted. msb exiting does
not prove that: msb runs the VM as a process of its own, and killing `msb.exe`
(a timeout, a cancel, the supervisor) skips the code that stops it. So every
Codex turn's VM carries a `commonly-seat=<seat folder>` label (`msb run
--label`), and the host acts as follows:
- Before any step under the HOME, it asks `msb list --label <seat> --format
  json` for that seat's VMs. msb checks each VM's process is alive. Any VM not
  `Stopped` or `Crashed` is stopped with `msb stop --force <name>`, which kills
  the VM's process and waits for it to exit. Then it lists again. If msb fails,
  its answer can't be read, or a VM is still listed, the turn refuses
  (`microvm_seat_busy`) and the HOME is not touched.
- After msb exits on its own, the same check runs before the reply is read and
  before the cleanup, because msb only warns when it fails to stop its VM.
- After `msb.exe` was killed, nothing touches the HOME: no reply read and no
  cleanup. The next turn's check stops the VM before its own steps, and its
  prepare clears what the killed turn left.
Another seat's VMs carry another label and are never listed or stopped.

One `agent run` process runs its turns one at a time, but two processes of one
seat can coexist (the daemon's and a foreground one). So the whole stretch, from
the first check through the cleanup, holds the seat's lock:
`.<seat folder>.lock`, beside the HOME in the host-owned `seats` folder that the
guest never mounts. The file names its holder (pid, a per-take token, and a
deadline: the turn's timeout plus 15 minutes from the take), and only an
exclusive create takes it. Age alone never frees it. A waiter reclaims it only
when the holder's pid is gone, or when the holder's own deadline has passed.
The holder checks that deadline before every host step under the HOME: before
preparing it, before writing `config.toml`, before booting the VM, after msb
exits, after the post-exit VM check (which can take minutes), and inside the
reply read and the cleanup before each folder check, read and removal. Once it
has passed, the holder stops and touches the HOME no more, so a live pid past
it is a reused pid or a holder that has stopped acting. This narrows the
window and does not remove it: a check passes, then the holder stalls (a
suspended laptop, a stopped process) for longer than the 15-minute margin
before the one step that check guarded runs, a waiter takes the lock
meanwhile, and that step then runs while the next turn's VM is up. A pid
check that fails counts as alive. A lock that names no holder yet (between its
create and its write) is left alone for a minute.

Every removal of the lock, a takeover or the holder's release, runs under a
short guard file (`<lock>.guard`, reading pid, token and a 30-second deadline)
and acts only on the file it judged. It first renames the file to a name only
it knows (atomic on Windows and macOS), then checks that file's content and
inode there; a file that is not the judged one is put back with a no-clobber
hard link. A takeover also re-reads the lock under the guard and goes ahead
only if the same file, with the same content and age, is still abandoned. The
guard follows the same rule as the lock: it is taken over only when its pid is
gone or its own deadline has passed, never on age while its holder may act,
and a guard holder past its deadline removes nothing. Node has no kernel file
lock (`flock`) without a native addon, so this is the mechanism. A second turn of the seat
waits up to two minutes, then refuses with `microvm_seat_busy`. It never runs
unlocked.

An `msb.exe` whose `agent run` was hard-killed takes no lock, and it could boot
its VM after the check. So, holding the lock and before the first check, the
host lists every `msb.exe` with its command line (PowerShell
`Get-CimInstance Win32_Process`) and kills each whose command line names this
seat's label or HOME. It then lists again until none is left. A listing that
fails or can't be read, or a process that survives, refuses the turn. After
that sweep nothing can start a VM of the seat, so a VM still running at the
check is a leftover, and the check stops it. A Windows job object would tie the
VM to the CLI's process, but Node has no way to make one without a native
addon.

Under the lock and after the check, the host also removes replies a killed turn
left, and checks that the seat's stored thread has its rollout in the guest
Codex home (walked without following links, and at most 20,000 entries: past
that the thread counts as absent, so a planted tree can't stall the host while
it holds the lock). A thread from before the seat ran
in the microVM lives in another Codex home, so the turn starts a new thread
instead of failing to resume it on every turn.

**Other differences.**
- The host-side git check for a public Codex workspace
  (`workspace-git-config.js`) is skipped. It exists because Codex runs git
  outside its profile, as the operator. In the VM, git runs in the guest over a
  read-only mount, so nothing in the repository runs on this computer.
- The reply is written to a file in the seat HOME with a name drawn fresh each
  turn. The host reads it only if it is a plain file, never through a link, and
  reads at most 256 KB of it; a longer reply is cut there and says so.
- The seat HOME is separate from a Claude seat of the same name.
- No context-token count is reported: reading the rollout would walk
  guest-written folders on the host.

## Known limits

- The files in `sessions/` are the seat's own conversation, and are kept as
  they are. Codex writes them outside bwrap, so the model's shell can't change
  them, but anything that could write the seat HOME could plant or rewrite the
  stored thread's rollout. A resumed thread would then carry that history, and
  whatever Codex restores from it, as if the seat had said it: the same reach a
  prompt injection in the pod already has. It could not change the profile,
  the network fence, the MCP servers, the model or the config, since those come
  from `-c` overrides and the host-written `config.toml`, nor make the host
  follow a link (the rollout check walks without following links).
- Read-only seats only. Write and web grants need a walk of their own (a
  read-only `.git` mounted over a writable workspace, and a fenced web route).
- DNS stays open (`allow@dns`), so a guest can leak data through lookups. The
  host alias resolves through msb's resolver; whether it still resolves without
  that rule is untested.
- Stopping a turn kills `msb.exe`, and the VM can outlive it, still holding
  the seat HOME mounted until something stops it. For a Codex seat, the next
  turn stops it before touching the HOME, or refuses (see above). Until that
  turn, it runs inside the fence and uses memory and CPU.
- A Claude turn's VM carries no label and nothing stops it. The host never writes into a Claude
  seat's HOME (it only makes the folder; the reply comes over stdout), so that
  leftover can reach nothing outside its fence and its mounts, but it runs
  until msb's own maintenance or someone stops it.
- The bridge runs only the Commonly MCP server, and only a warm build whose
  `package.json` declares `commonly.withheldTools`: it runs on the host, outside
  Claude's deny list, so it must withhold the seat's tools itself. Any other
  declared server is refused, since on the host it would run outside the VM
  with the workspace writable. Builds published before that marker are refused
  too, so the mode needs the first `@commonlyai/mcp` release after this change.
  HTTP and SSE servers are refused, not silently cut off.
- The guest installs Claude Code with the network open, once, with no secrets
  in the VM. Every turn after that runs fenced.
- Claude's context-token count read from the transcript is not wired up yet.
  The transcript lives in the seat HOME under a guest path.
- The guest Codex reading its MCP entries from the host-written `config.toml`
  is untested end to end: the CI turn declares no MCP server.
- `attach` and `agent run` still detect Codex on the host, as they detect
  Claude, though the turn runs the guest's copy.
- Tested on GitHub's `windows-latest` runner, not yet on a Windows desktop.

## Tests

- `cli/__tests__/sandbox.microsandbox.test.mjs`: the fence, the WHP probe, the
  pinned download, and the run arguments.
- `cli/__tests__/sandbox.microsandbox-mcp-bridge.test.mjs`: the bridge and its
  secret.
- `cli/__tests__/sandbox.microvm-mode.test.mjs`: the three invariants (flag-off
  resolution, never stored, fail closed), plus the claude adapter's turn.
- `cli/__tests__/sandbox.guest-home.test.mjs`: no host operation under a seat
  HOME follows a link (a junction stood in for by an injected `lstat`).
- `cli/__tests__/adapters.codex.microvm.test.mjs`: the same invariants for the
  codex adapter: resolution with the flag on and off, declared and undeclared;
  every refusal; the fence; the provider key and seat token kept out of the
  guest's argv, env and turn files; and the guest MCP entry's env table. Also
  the seat's VMs: a killed or cancelled turn leaves the HOME alone; a live VM
  of the seat is stopped before the HOME is touched, or the turn refuses; and
  another seat's VM neither blocks nor is stopped. Two concurrent turns of one
  seat: the second waits at the lock without touching the HOME, or refuses. An
  orphaned `msb.exe` is swept before the VM check, and a failed sweep refuses;
  a stale reply is removed; a stored thread with no guest rollout starts fresh;
  everything in the Codex home but `sessions/` and `tmp/arg0-linux/` is cleared,
  and a link there refuses the turn.
  `sandbox.microsandbox.test.mjs` covers the lock itself: a dead holder's lock
  is reclaimed, and so is one past its holder's deadline; a live holder's is
  never taken on age; an empty lock waits out its grace period; a lock replaced
  during the judgement survives; a live guard inside its deadline is never
  taken on age, and a removal puts back any file but the one it judged. It
  also covers the orphan sweep, the exact
  version match, and the MCP declaration check `attach` shares with the turn.
- `.github/workflows/cli-microsandbox-windows.yml` runs these on Windows. It then
  boots a real fenced VM with `cli/scripts/windows-microvm-smoke.mjs` and probes
  from inside: the proxy answers; another loopback service, the internet and a
  wrong bridge secret do not; the workspace, its `.git` and the agents volume
  refuse writes. A second smoke, `cli/scripts/windows-microvm-codex-smoke.mjs`,
  runs one public Codex turn through the codex adapter's own spawn. The model
  is a stub on the runner, behind the CLI's real provider proxy, holding a fake
  key. It first plants a junction at a seat HOME's `codex-home` and expects a
  refusal with the target untouched. Then it checks that Codex answers, that the
  stub's own request log shows the key in every request's Authorization header,
  and that neither msb's arguments nor the guest's turn files carry it. It then
  checks that the host reaches the public URLs (or stops as inconclusive), and
  boots the same fence again with a probe, which finds those URLs and a
  loopback-only host port unreachable and the fenced port reachable. A public
  URL counts as blocked in exactly two cases: no connection at all, or msb's
  gateway answering a plain-HTTP request with 403 and a JSON body whose `code`
  is `network_policy_denied`. Any other answer counts as reachable. Last, a
  turn whose guest stalls is killed at a 60-second timeout. While it runs, msb
  must list it under the seat's label, and must not list a control VM carrying
  another label there, so the check can't pass vacuously. The next turn of that
  seat must still answer. msb must then list no running VM with the seat's
  label, and the control VM must be untouched. The log shows whether the VM
  outlived `msb.exe`.
- The Codex smoke also has the stub model ask for one shell command through
  Codex's own shell tool in the guest. That command must read a workspace file,
  and must fail to write the workspace, to read the `config.toml` that carries
  the bridge secret (present when the turn started), and to reach the internet.
  Its write to the Codex home must not reach the seat HOME, while Codex's own
  rollout must (the positive control). Files then planted in that home outside
  `sessions/` and the helper folder must be gone when the next turn launches
  msb, and that turn must resume the thread and answer. Finally a stand-in orphan, a copy of node named
  `msb.exe` whose command line carries a seat's label and HOME, must be killed
  before that seat's next turn reaches its VM check, and that turn must answer.
