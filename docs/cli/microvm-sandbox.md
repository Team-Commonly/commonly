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
`COMMONLY_MCP_WITHHELD_TOOLS`. The guest's Codex gets each entry as `-c
mcp_servers.<name>.*` overrides: the guest shim as its command, Codex's
`disabled_tools` for the same withheld list, and an `env` table with the bridge
address and the turn secret. Codex passes its MCP children none of its own
environment, so without the table the shim couldn't find the bridge and the
tools would never appear. Any other declared server, and any HTTP server,
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
folder and the agents volume. It can't read the turn folder, which holds the
bridge secret, and it can't write the seat HOME. The spike showed Codex's
sandbox runs in the guest, since the guest kernel allows user namespaces. If a
later Codex or guest image can't start it, shell commands fail and the turn
reports it. Nothing falls back to full access. The guest's Codex home is
`/home/seat/codex-home`, not `~/.codex`, because the profile denies `~/.codex`
whole and the arg0 helper lives in the Codex home. The host also rewrites
`AGENTS.md` and removes `AGENTS.override.md` before every turn, and Codex runs
with `--ignore-user-config` and `--ignore-rules`, so a `config.toml` or rules
file left in the HOME never loads.

**Other differences.**
- The host-side git check for a public Codex workspace
  (`workspace-git-config.js`) is skipped. It exists because Codex runs git
  outside its profile, as the operator. In the VM, git runs in the guest over a
  read-only mount, so nothing in the repository runs on this computer.
- The reply is written to a file in the seat HOME with a name drawn fresh each
  turn. The host reads it only if it is a plain file, never through a link.
- The seat HOME is separate from a Claude seat of the same name.
- The context-token count is read from the rollout in the seat HOME, as on the
  other hosts.

## Known limits

- Read-only seats only. Write and web grants need a walk of their own (a
  read-only `.git` mounted over a writable workspace, and a fenced web route).
- DNS stays open (`allow@dns`), so a guest can leak data through lookups. The
  host alias resolves through msb's resolver; whether it still resolves without
  that rule is untested.
- Stopping a turn kills `msb.exe`. Whether the VM process always goes with it is
  untested; one left behind costs memory, not access.
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
- `cli/__tests__/adapters.codex.microvm.test.mjs`: the same invariants for the
  codex adapter: resolution with the flag on and off, declared and undeclared;
  every refusal; the fence; the provider key and seat token kept out of the
  guest's argv, env and turn files; and the guest MCP entry's env table.
- `.github/workflows/cli-microsandbox-windows.yml` runs these on Windows. It then
  boots a real fenced VM with `cli/scripts/windows-microvm-smoke.mjs` and probes
  from inside: the proxy answers; another loopback service, the internet and a
  wrong bridge secret do not; the workspace, its `.git` and the agents volume
  refuse writes. A second smoke, `cli/scripts/windows-microvm-codex-smoke.mjs`,
  runs one public Codex turn through the codex adapter's own spawn. The model
  is a stub on the runner, behind the CLI's real provider proxy, holding a fake
  key. The smoke checks that Codex answers, that the stub saw the key, and that
  neither the reply nor the guest's turn files carry it. It then boots the same
  fence again with a probe, which finds the public internet and a loopback-only
  host port unreachable and the fenced port reachable.
