# microsandbox spike: a sandbox for agents on native Windows

**Status:** spike done. Nothing in the CLI or backend changes, and nothing is deployed.
**Asked for by:** the next-tech-stack review, as its second spike, after the OpenShell one (`docs/plans/openshell-spike.md`).
**Pins:** microsandbox v0.8.1 (released 2026-11-23, Apache-2.0), `microsandbox-windows-x86_64.zip`, SHA-256 `b0f57ecb…d1fe88cde2` from the release's own `checksums.sha256`. The install script wasn't run; the probe downloads the archive and checks the hash.

## Why Windows

Native Windows is where the CLI has no sandbox today. `bwrap` is Linux-only and Seatbelt is macOS-only, so on Windows:
- a daemon-run seat runs unconfined (`cli/src/lib/daemon-service-windows.js`);
- no agent gets connector grants (`cli/src/lib/grant-broker-guard.js`);
- `--unsandboxed` is the only way to run (`cli/src/lib/sandbox/windows-unsandboxed.js`).

microsandbox boots a Linux microVM per sandbox through the Windows Hypervisor Platform (WHP). The question was whether it runs where we can test it for free, and whether it holds the same fence as a Linux sandbox.

## Short answer

Yes. On a free GitHub-hosted `windows-latest` runner, with no paid infra:

- **WHP is on.** The runner is a Windows Server 2025 VM on Azure (10.0.26100) with `HypervisorPlatform`, `Microsoft-Hyper-V` and `VirtualMachinePlatform` all enabled, so nested virtualization works. The first microVM printed "hello from a microVM" (guest kernel 6.12.118).
- **The fence holds when it's set up the right way.** With `--no-net` plus port rules, a sandbox reached exactly the ports it was given. Vendor hosts, the raw upstream, the public internet and cloud metadata were all refused.
- **Claude Code 2.1.331 and Codex 0.172.0 both ran inside** and answered through Commonly's provider proxy, with only DNS and the two proxy ports open. The stub model echoed the upstream key, and both agents received `[redacted]`.
- **Codex's own sandbox works inside.** User namespaces are allowed in the guest, so Codex ran with its read-only bubblewrap sandbox on. This is the nesting that OpenShell refuses (its hazard 2).
- **Two traps:** port rules on their own leave the public internet open, and domain rules didn't connect. A third problem: `msb create` fails on the runner. Details under Findings.

## Results

Every key is fake. The front (`scripts/spikes/sandbox-front.mjs`) is the OpenShell spike's front: a stub model that echoes the key it receives, and Commonly's real provider proxy (`packages/seats/src/wire/provider-proxy.js`) for each wire. Every listener binds to the runner's `127.0.0.1` only, plus a loopback-only stand-in for Postgres on port 18199.

### Network fence

`host.microsandbox.internal` is the runner, as seen from the guest.

| Policy | example.com | host :18100 (proxy) | host :18199 (loopback-only) | metadata `169.254.169.254` |
|---|---|---|---|---|
| default | **open** | refused | refused | blocked (gateway 403) |
| `--no-net` | refused | refused | refused | blocked |
| `--no-net` + `allow@host:tcp:18100` | refused | **open** | refused | blocked |
| `--no-net` + `allow@dns,allow@host` (whole group) | refused | open | **open** | blocked |
| `allow@dns,allow@registry.npmjs.org:tcp:443` (no `--no-net`) | **open** (api.anthropic.com answered 401) | | | |

A connection to `169.254.169.254:80` opens under every policy, but no request reaches the metadata service. The gateway accepts the connection and answers 403 with no `Server` header. A plain-HTTP request to example.com that the policy blocks gets the same answer, and Azure's metadata service would answer 400 to a request without its header.

### Driver contract (python image, one sandbox, several runs)

| Check | Result |
|---|---|
| code on stdin (`… \| msb exec NAME -- python3 -`) | runs; `--stream` works too |
| host environment inside | absent: a variable set on the host didn't appear in the guest |
| nonzero exit | passed through (exit 3) |
| `msb exec --timeout 3s` | exit 1 after about 4.2 s, stderr `exec timed out after 3s` |
| one exec in a running sandbox | 1.2–1.5 s (`-q` changes nothing) |
| `msb run python` warm, or `msb run node` cold with the image pull | about 1.6 s / 4.4–5.9 s |
| root inside, writes to `/etc` | allowed; the VM is the boundary |
| user namespaces inside | allowed |

### Agents

Installed unfenced onto an ext4 disk volume in 24 s, then run from that volume under `--no-net --net-rule allow@dns,allow@host:tcp:18100,allow@host:tcp:18101`:

| Check | Result |
|---|---|
| `claude -p 'reply with OK' --model spike-model` | answered through the proxy, exit 0, key echo `[redacted]` |
| `codex exec` (its own read-only sandbox on) | answered through the proxy, exit 0, key echo `[redacted]` |
| `codex exec --sandbox danger-full-access` | same |
| api.anthropic.com, api.openai.com | refused |
| raw upstream (host :18090, not in the allowlist) | refused |
| whole agents run | 6 s |

## Findings

1. **A free hosted Windows runner can host microsandbox.** So Windows sandbox work can be tested in CI at no cost, and a Windows CLI sandbox mode can have a real test tier. On a user's machine, WHP has to be turned on, which takes admin rights and a reboot. The CLI can detect that, but it can't do it for the user.
2. **Port rules alone don't close the network.** The help text says egress defaults to deny once any rule is present. In practice, with `--net-rule` but without `--no-net`, the public internet stayed open. A driver must always pass `--no-net` and then add its rules, and it needs a test that a vendor host is refused.
3. **`allow@host` reaches everything bound to the host's loopback.** It's the same hazard as OpenShell's hazard 1. A rule naming the host group without a port reached the loopback-only stand-in for Postgres. Port-scoped rules held: `allow@host:tcp:18100` reached 18100 and nothing else. Any driver has to build its rules in code as port-scoped allowlists.
4. **Domain rules didn't connect.** `allow@registry.npmjs.org:tcp:443`, `allow@registry.npmjs.org` and `allow@*.npmjs.org`, each on `--no-net` with `allow@dns`, all reset at the TLS handshake. So either install agents unfenced onto a volume and then run them fenced (what worked here), or route installs through a proxy on an allowed host port. Whether domain rules need TLS interception is still open.
5. **`msb create` fails on the runner** with `io error: Access is denied. (os error 5)`. The sandbox is still recorded as stopped, and `msb exec` starts it, but the error is unexplained, and `RUST_LOG=debug` adds nothing. `msb run` works every time, at about the same cost as an exec (1.2–1.6 s), so a driver can use one `msb run` per turn and skip `create` until this is understood.
6. **`msb modify` can't change the network.** A sandbox keeps its creation fence, so install and run happen in two sandboxes that share a volume.
7. **Nesting works, unlike OpenShell.** The guest is a full Linux kernel with user namespaces, so an agent's own sandbox (Codex's bubblewrap, our CLI's `bwrap` mode) can start inside. That makes microsandbox a candidate for a real layered sandbox: the microVM outside, and the agent's own sandbox inside.

## What a Windows sandbox mode would need

This is a sketch, not a decision. Building it is a separate change.

- **A `microsandbox` sandbox mode** in the local CLI wrapper (ADR-005, ADR-008), for native Windows only to start with. `attach` would refuse it with a clear message when WHP is off.
- **A pinned `msb`**, downloaded by the CLI into its own prefix and checked against a hash shipped in the CLI, never through the install script, and never a global install.
- **A fence built in code:** `--no-net`, `allow@dns`, and port-scoped `allow@host:tcp:<port>` rules for the provider proxy and grant broker only. Tests have to cover findings 2 and 3.
- **The agent's install on a disk volume,** done once with the network open, then mounted into each fenced run.
- **The workspace mounted** with `--mount-dir` (Windows paths go through microsandbox's passthrough filesystem). This spike didn't test that.
- **Then the grant broker's Windows refusal and the unconfined-daemon warning can be revisited**, once the mode has been walked on a real Windows machine and not only on a runner.

## Not done

- No CLI or backend code. The probe is the evidence.
- No real Windows desktop (Home or Pro). The runner is a Server VM with Hyper-V already on.
- Workspace mounts, file writes back to the host, and memory and CPU limits under load weren't tested.
- The cause of the `create` error is unknown.
- No model-driven tool call inside: both agents answered a stub model, with no tool use.

## Reproduce

`.github/workflows/microsandbox-windows-probe.yml` runs `scripts/spikes/microsandbox-probe.ps1` on `windows-latest`. Run it from the Actions tab (workflow_dispatch). It needs no secrets and takes about 8 minutes.
