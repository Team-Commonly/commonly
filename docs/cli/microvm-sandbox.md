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
inside it, and it guards the one thing the VM leaves writable, the seat HOME.
That HOME keeps Codex's sessions, and Codex loads `AGENTS.md` and skills from
its Codex home. With full access, a prompt-injected shell could leave
instructions there for every later turn. Under the profile, the model's shell
can read only the system's minimal set, the workspace, Codex's arg0 helper
folder and the agents volume, and it can't write the seat HOME. The Codex home,
where the secret-bearing `config.toml` sits, is outside that read set. What the
profile does not hide is `/proc`: if a later change put the secret back in argv,
the model's shell could read it there. The turn folder holds the per-turn proxy
token, which reaches only the proxy and only for this turn. The spike showed Codex's
sandbox runs in the guest, since the guest kernel allows user namespaces. If a
later Codex or guest image can't start it, shell commands fail and the turn
reports it. Nothing falls back to full access. The guest's Codex home is
`/home/seat/codex-home`, not `~/.codex`, because the profile denies `~/.codex`
whole and the arg0 helper lives in the Codex home.

**Nothing a turn writes persists into the next.** Before every turn the host
clears what Codex would load from its home (`AGENTS.override.md`, `config.toml`,
`managed_config.toml`, `hooks.json`, and the `skills`, `prompts`, `rules`,
`hooks` and `plugins` folders), rewrites `AGENTS.md` from the seat's declared
skills, and then writes the turn's own `config.toml`. Codex runs with
`--ignore-rules`. It does not run with `--ignore-user-config`, since it reads
that host-written `config.toml`; every other setting rides in `-c` overrides,
which win over the file. Sessions stay, so a thread resumes.

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
guest never mounts. It works like the install lock. The file names its holder
(pid and a per-take token), and only an exclusive create takes it. A waiter
reclaims it only when the holder's process is gone, or when the lock is older
than the turn's timeout plus 15 minutes (a reused pid). The reclaim re-reads the
file under a guard and deletes only the exact lock it judged. A second turn of
the seat waits up to two minutes, then refuses with `microvm_seat_busy`. It
never runs unlocked. So a VM of the seat still running at the check is always a
leftover. A Windows job object would tie the VM to the CLI's process, but Node
has no way to make one without a native addon, so the check above is the
mechanism.

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

- Read-only seats only. Write and web grants need a walk of their own (a
  read-only `.git` mounted over a writable workspace, and a fenced web route).
- DNS stays open (`allow@dns`), so a guest can leak data through lookups. The
  host alias resolves through msb's resolver; whether it still resolves without
  that rule is untested.
- Stopping a turn kills `msb.exe`, and the VM can outlive it, still holding
  the seat HOME mounted until something stops it. For a Codex seat, the next
  turn stops it before touching the HOME, or refuses (see above). Until that
  turn, it runs inside the fence and uses memory and CPU.
- The seat lock follows the `agent run` process, not `msb.exe`. If that process
  dies mid-turn, its `msb.exe` can live on, and the lock is reclaimed. If that
  orphaned msb boots its VM only after the next turn's check, the VM runs while
  the next turn touches the HOME. That window is short: the process is gone
  within seconds of spawning msb, and the restarted turn's check comes later.
  Nothing covers it. A Claude turn's VM
  carries no label and nothing stops it. The host never writes into a Claude
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
- Codex's tool calls inside the guest are untested in CI: the stub model asks
  for none. The spike ran a command through Codex's own sandbox in the guest;
  the CI turn proves Codex starts and answers under the profile.
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
  seat: the second waits at the lock without touching the HOME, or refuses.
  `sandbox.microsandbox.test.mjs` covers the lock itself: a dead holder's lock
  is reclaimed, a live holder's is left as it was.
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
