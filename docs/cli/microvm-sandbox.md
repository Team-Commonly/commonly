# The microVM sandbox on native Windows (opt-in)

Native Windows has neither Seatbelt nor bubblewrap, so a confined Claude seat
there used to have two choices: refuse, or run without an OS sandbox by the
person's own `--unsandboxed`. This mode adds a third. Each turn runs inside a
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
3. Give the agent `ANTHROPIC_API_KEY`. The key stays on the host, and the VM gets
   a per-turn proxy token instead. A subscription login has no way into the VM.

A public or workspace seat with no declared `sandbox.mode` then resolves to
`microvm` on that host. The first turn downloads msb (about 30 MB) and installs
Claude Code into a disk volume. Later turns boot in a couple of seconds.

## What holds

| | How |
|---|---|
| Mode | Host-resolved in `sandbox/mode.js`, the only reader of the flag. It is never stored: an environment file that names `microvm` fails validation. |
| Adapters | Claude only. Attach, the run-time host check and every other adapter refuse it. |
| Fail closed | The claude adapter checks the platform, the flag, WHP and msb at every spawn. A missing piece refuses the turn; nothing falls through to a bare spawn. |
| Network | `--no-net`, then `allow@dns` and `allow@host:tcp:<port>` for exactly two ports: the provider proxy and the MCP bridge. There is never a whole-group `allow@host`, which reaches every service on the host's loopback. There is never a `--net-rule` without `--no-net` either, since that keeps the public internet open. |
| Credentials | The provider key stays in the host proxy. The Commonly MCP server, and with it the agent's runtime token, run on the host behind the bridge. The guest's shim must send the turn's secret first. |
| Files | The turn folder is read-only. The workspace is read-only unless the seat has `write`. The seat's own HOME lives under `%LOCALAPPDATA%\commonly\microsandbox\<version>\seats`. The Claude Code install lives on a named disk volume. Argv and env go through a turn file, never the msb command line. |
| msb | Pinned to v0.8.1 and checked against the release's SHA-256. It goes to `%LOCALAPPDATA%\commonly\microsandbox\0.8.1`, never through an install script and never globally. Moving the pin is a reviewed change, with the Windows workflow run on the new version. |
| Guest | `node:22-bookworm-slim`, pinned by digest, with Claude Code `2.1.331` on the `commonly-agents` volume. |

`--unsandboxed` still means what it did: the person's own choice to run a
Claude seat without an OS sandbox wins over the flag.

## Known limits

- Only stdio MCP servers can cross the bridge. An HTTP or SSE server is refused,
  not silently cut off.
- The guest installs Claude Code with the network open, once, with no secrets
  in the VM. Every turn after that runs fenced.
- The context-token count read from the transcript is not wired up yet. The
  transcript lives in the seat HOME under a guest path.
- Tested on GitHub's `windows-latest` runner, not yet on a Windows desktop.

## Tests

- `cli/__tests__/sandbox.microsandbox.test.mjs`: the fence, the WHP probe, the
  pinned download, and the run arguments.
- `cli/__tests__/sandbox.microsandbox-mcp-bridge.test.mjs`: the bridge and its
  secret.
- `cli/__tests__/sandbox.microvm-mode.test.mjs`: the three invariants (flag-off
  resolution, never stored, fail closed), plus the claude adapter's turn.
- `.github/workflows/cli-microsandbox-windows.yml` runs these on Windows. It then
  boots a real fenced VM with `cli/scripts/windows-microvm-smoke.mjs` and probes
  the fence from inside.
