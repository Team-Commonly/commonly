# OpenShell spike: a sandbox boundary for hosted agents that run code

**Status:** spike done, driver behind a flag (off by default). Not deployed anywhere.
**Asked for by:** the next-tech-stack review, as its first spike.
**Pins:** OpenShell v0.1.9 (released 2026-11-17, Apache-2.0). Refs are to `origin/main` at `f471811d4`.

## The question

Can OpenShell replace the E2B per-turn sandbox (ADR-023 A2) as the boundary for a hosted turn's code, with Commonly's provider proxy and grant broker staying in front? And do Claude Code and Codex run inside it? OpenShell's docs walk through OpenCode and Pi only.

## Short answer

Yes for both, on one Docker host, with two hazards and one gap:

- A hosted turn's Python and JavaScript ran inside OpenShell's Docker driver. The fence held: outbound denied, writes outside the workdir denied, no environment.
- Claude Code 2.1.331 and Codex 0.172.0 both ran inside and answered through our provider proxy. The stub model echoed the upstream key, and both agents received `[redacted]`.
- **Hazard 1:** a policy rule for `host.openshell.internal` reaches services bound only to the gateway host's `127.0.0.1`. On a single VM, that includes Postgres and Mongo. The run-code driver writes no network rule at all, and a later rule for the proxy or broker must be an allowlist of exactly those ports.
- **Hazard 2:** user namespaces are refused inside the sandbox. An agent's own sandbox (Codex's bubblewrap, our CLI's `bwrap` mode) cannot start, so OpenShell is the only boundary, and the agent must run with its own sandbox off.
- **Gap:** this ran on Docker Desktop's Linux VM (kernel 6.12.76, arm64), not on our VM. Whether the VM's kernel meets OpenShell's Landlock ABI 3 (Linux 6.2+) is unchecked.

## Must fix before enabling

The flag stays off on every instance until both of these are fixed and the driver has been reviewed again. Item 1 needs a test. Item 2 needs a decision, plus a test that the driver starts an agent with its own sandbox off.

1. **`host.openshell.internal` reaches the gateway host's loopback.** In the spike, a rule naming `host.openshell.internal:<port>` reached a service bound only to `127.0.0.1` on the gateway host (finding 2). On a single VM, that puts Postgres, Mongo and the backend one policy line away from model-written code. Before any rule opens a way out:
   - it must be an allowlist of exactly the provider proxy and grant broker ports, built in code and never taken from config as a free list;
   - a test must show that a sandbox can't reach a loopback service the allowlist doesn't name;
   - the gateway must run where its host's loopback holds nothing else, or in bridge mode once bridge mode is shown to close this.

   The built-in `SANDBOX_POLICY` has no network rule. `OPENSHELL_SANDBOX_POLICY_FILE` replaces that policy wholesale, and the driver passes the file to `openshell sandbox create --policy` without reading it, so a deployment can add a rule through configuration alone. Before enabling, either remove the override or make the driver refuse a file whose `network_policies` go beyond the code-defined allowlist.
2. **No user namespaces inside, so no nested sandbox.** An agent's own sandbox (Codex's bubblewrap, our CLI's `bwrap` mode) can't start inside OpenShell, so OpenShell's policy is the only boundary (finding 3). Before a hosted agent runs inside:
   - the driver must start the agent with its own sandbox off, on purpose and visibly (for example, Codex with `--sandbox danger-full-access`);
   - ADR-008 needs a decision. It defines `container` mode for the local-CLI and OpenClaw paths only, and refuses to run an install whose asked-for sandbox mode can't be met. A hosted driver extends `container` mode to a new path, so the ADR has to say whether `container` under OpenShell satisfies an install that asks for `bwrap`, or whether that install is refused;
   - the OpenShell policy must be at least as tight as the seat sandbox it replaces: writes to the workdir only, and no egress beyond the allowlist in item 1. Today's `SANDBOX_POLICY` doesn't meet that yet. Besides the workdir, it grants writes to `/sandbox` and `/tmp`, and reads to `/usr`, `/lib`, `/etc`, `/proc` and `/var/log`. Those are enough for one run of a turn's code. For an agent, each write path has to be removed or justified.

## What was run

Everything ran on this Mac with no paid infrastructure. It ran inside one disposable Docker-in-Docker container (`docker:28-dind`, Docker 28.5.2), so OpenShell's sandboxes never touched the host's other containers.

- **Not the installer.** OpenShell's `install.sh` (read at the tag first) installs through Homebrew and starts a brew service on macOS, and needs root plus a system package and a systemd user unit on Linux. Neither fits a shared host. The gateway ran as OpenShell's own container image instead, following `docs/how-it-works/gateways/container-deployment.mdx`.
- **Pinned by digest:**
  - gateway `ghcr.io/nvidia/openshell/gateway@sha256:1fd9e1e8…`
  - supervisor `…/supervisor@sha256:f1ec231b…`
  - sandbox runtime `…/sandbox@sha256:e57d07cd…`
  - the CLI is the `openshell-aarch64-unknown-linux-musl` release asset, sha256-checked against the release's checksum file.
- **Telemetry off:** `OPENSHELL_TELEMETRY_ENABLED=false` on the gateway, confirmed in the running container's config. Their docs say the gateway passes it to sandbox supervisors. I didn't watch the network to confirm nothing is sent.
- **Gateway config:** upstream's `deploy/docker/gateway.toml`, with images pinned and `default_image` set to `nvcr.io/nvidia/base/ubuntu:24.04` by digest. TLS was off, bound to loopback, which is acceptable only inside the throwaway container.

## Results

| Check | Result |
|---|---|
| Sandbox ready (image cached) | about 1 s |
| Driver: create plus first Python run | 0.6–1.1 s over two runs; next run about 0.1 s |
| Python 3.12 and Node in the workload image | ran |
| Workload identity | uid 1000, `NoNewPrivs: 1`, seccomp in filter mode |
| Outbound to example.com | refused (`EACCES`) |
| Write to `/etc` | refused |
| Gateway data path visible inside | no |
| Secret-looking env vars inside (backend env held `JWT_SECRET`) | none |
| Run past 30 s | OpenShell's `--timeout` ends it with exit 124; the sandbox stays usable |
| Delete at turn end | no sandbox left behind (every run here; if a delete fails, the sandbox's 180 s lifetime ends it) |

### Claude Code and Codex inside, behind our proxy and broker

Setup: an image with `@anthropic-ai/claude-code@2.1.331` and `@openai/codex@0.172.0` on `node:22-bookworm-slim`.
- **The policy's only network rules:**
  - two front ports for Commonly's provider proxy (`packages/seats/src/wire/provider-proxy.js`, unmodified, one per wire), allowed only for the node and agent binaries;
  - one port for a stub grant broker shaped like `POST /api/mcp/grants/:grantId`, allowed for python.
- **No vendor host is listed.** The upstream was a stub model server that echoes the key it receives. Every key was fake.

| Check | Result |
|---|---|
| `claude -p 'reply with OK'` via `ANTHROPIC_BASE_URL` = the proxy | answered; it saw `key-echo=[redacted]` |
| `codex exec` with a `responses` provider pointed at the proxy | answered; it saw `key-echo=[redacted]` |
| Upstream received the real (fake) key from the proxy, never the sandbox's token | yes, per the front's request log |
| Broker call from python with the agent token | 200 |
| Python to the proxy port (binary not in that rule) | refused |
| Node straight to `api.anthropic.com` | refused |
| Node to a port no rule names | refused |
| Any upstream key in the agents' output | none |
| `unshare -U` inside | refused |
| Codex's bundled bubblewrap, `codex sandbox linux` | refused: "No permissions to create a new namespace" |

A model-issued tool call wasn't tested (the stub model returns text only). Codex answered a text turn with its own sandbox on, because no command ran. A turn that runs a shell command would need `--sandbox danger-full-access` inside OpenShell, and Claude Code's Linux sandbox would hit the same refusal. That last point is inferred from the namespace refusal, not run.

## Findings that shape the design

1. **Our proxy has to stay in front.** OpenShell's own provider path injects credentials outbound but doesn't scrub a key echoed back (their docs say so). Ours does. In the run above, the agent saw `[redacted]` only because our proxy sat between OpenShell and the upstream.
2. **`host.openshell.internal` reaches the gateway host's loopback.** With supervisor networking in host mode (the Docker driver's default), a rule naming `host.openshell.internal:<port>` connected to a service bound only to `127.0.0.1` on that host. So any rule that opens a way out must be an allowlist of exactly the proxy and broker ports, never a denylist: a denylist leaves every other loopback service reachable (the backend API, a kubelet, any published port). This PR's driver opens no way out at all. Bridge mode wasn't tested.
3. **No nested sandboxes.** User namespaces are refused, so an agent's own sandbox can't start inside. Under OpenShell, ADR-008's local `bwrap` mode has to be off and OpenShell's policy is the boundary. That's acceptable for hosted agents, but it has to be decided on purpose, not discovered.
4. **The workload image must name a non-root user and carry `/etc/passwd`.** The driver resolves the workload identity from the image. A scratch-style image fails with `IdentityResolutionFailed`, and so does the sandbox runtime image used as a workload image. A root-user image is refused unless the policy sets `run_as_user`.
5. **CLI constraints the driver had to learn live** (the mocked tests passed before each fix):
   - sandbox names are capped at 19 characters;
   - `--no-keep` can't be combined with `--output`;
   - `sandbox exec --timeout` exits 124.
6. **v0.1.x moves fast.** There was a breaking gateway model at 0.0.37 and a pre-0.1.0 `--from ./Dockerfile` change, and their docs say experimental interfaces "may change or be removed in a patch release". Pin by digest and re-run this spike before any upgrade.

## The driver (this PR)

`backend/services/openshellTurnSandbox.ts` is the ADR-008 `container`-mode driver for the hosted path. It has the same contract as `TurnSandbox` in `turnSandboxService.ts`: one sandbox per turn, five runs, 30 s each, output clipped to the same limits, deleted at turn end, and the busy line on a refusal.

- **Flag:** `OPENSHELL_SANDBOX_ENABLED=true` plus `OPENSHELL_SANDBOX_IMAGE` (an image with python3 and node). With the flag on, `commonly_run_code` uses OpenShell instead of E2B. It's still offered only to installs that declare it.
- **Gateway:** the `openshell` CLI (`OPENSHELL_BIN`), pointed by `OPENSHELL_GATEWAY_ENDPOINT` or `OPENSHELL_GATEWAY`. The CLI gets only those variables, plus `PATH`, `HOME` and `XDG_CONFIG_HOME`, never the backend's environment, because the CLI is outside code.
- **Policy:** `SANDBOX_POLICY` has no network rule at all, and sets Landlock to `hard_requirement`, so on a kernel without Landlock ABI 3 the create fails and the model gets the busy line, instead of the code running without filesystem rules (`best_effort` would do that). It's written once to a 0600 temp file, or comes from `OPENSHELL_SANDBOX_POLICY_FILE`. `hard_requirement` passed live on kernel 6.12.
- **Bounds:** every create step shares one 30 s deadline, so a refused create holds the turn no longer than E2B's bounded create. A refused sandbox is deleted without holding the turn. A CLI that fails outright (missing, or killed) gives the busy line, and its stderr, which names the gateway, stays in the server log.
- **Backstop:** the sandbox's main process is `sleep 180` with `--no-keep`, so a failed delete still ends.
- **Billing:** `close()` returns 0 seconds, because a self-hosted sandbox has no vendor bill and the spend alarm prices `sandboxSeconds` as E2B time.

## Not done, and what would close it

- **Our VM's kernel.** Before any deploy, someone with VM access runs `uname -r` and OpenShell's own qualification (`openshell doctor`) on a copy of the VM, never prod. Landlock ABI 3 needs Linux 6.2+, and their docs say a version number alone doesn't establish support.
- **Shipping the CLI and the gateway.** The backend image doesn't carry `openshell`, and nothing deploys a gateway. On a single Docker host, the gateway is one more Compose service with the Docker socket. That's a real grant of power to outside code, so it's a decision for the CTO and SRE, not this PR.
- **TLS and auth on the gateway.** The spike ran with TLS off on loopback. A deployed gateway needs mTLS (`generate-certs`), per their container-deployment doc.
- **The gRPC API instead of the CLI.** Shelling out costs about 100 ms per call. A production driver would use the gateway's gRPC endpoint once its interfaces settle.
- **A cold image pull.** The run-code image is about 260 MB. The first turn after a deploy waits on the pull unless the image is pre-pulled.
- **A model-driven tool call inside** (Codex or Claude Code running a command), against a real model, through our proxy.

## How it was reproduced

1. Start `docker:28-dind` privileged, with a named volume.
2. Inside it, run `generate-certs` from the pinned gateway image, then start the gateway with the config above, the inner Docker socket and `OPENSHELL_TELEMETRY_ENABLED=false`.
3. Register the pinned CLI with `openshell gateway add http://127.0.0.1:8080 --local`.
4. Build the two workload images (a python and node one on the Ubuntu base, and one with the agents) inside the dind container.
5. Start the front: a stub upstream on loopback, our provider proxy, and the stub broker. I also forwarded the proxy to a non-loopback address, but finding 2 shows that wasn't needed.
6. Run the checks above with `openshell sandbox create/exec/delete`.
7. Run the driver itself, compiled from this file, from a Node container on the same network.
