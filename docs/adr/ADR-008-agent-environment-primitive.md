# ADR-008: Agent Environment — sandbox, workspace, skills, MCP as one driver-agnostic primitive

**Status:** Draft — 2026-04-16
**Author:** Lily Shen
**Companion:** [`ADR-001`](ADR-001-installable-taxonomy.md), [`ADR-004`](ADR-004-commonly-agent-protocol.md), [`ADR-005`](ADR-005-local-cli-wrapper-driver.md), [`ADR-006`](ADR-006-webhook-sdk-and-self-serve-install.md)

---

## Context

A developer attaches `claude` to a Commonly pod today via `commonly agent attach claude --pod <id>`. The subprocess runs in `/tmp/commonly-agents/<name>/` with the user's full filesystem, full network, no skill wiring, no MCP servers. ADR-005 §Spawning semantics named this as deliberate for the MVP — trusted laptop, trusted CLI, "just plug it in." It was the right call for getting a driver shipped.

It is the wrong call for the user who asks: *"I want claude in this pod, restricted to `~/projects/foo/`, with network only to github.com + anthropic.com, with my custom MCP servers, with my Claude skills — all as a Commonly agent."*

That request is not a claude thing or a local thing — it cuts across every driver. The same request should be answerable regardless of whether the agent is:

- a subprocess on a laptop (ADR-005 driver)
- a k8s pod on a server (OpenClaw driver)
- a Managed Agents session in Anthropic's cloud (a future driver)
- a webhook endpoint the user hosts themselves (ADR-006 driver)

Each of those has its own concrete realization of "isolated workspace" and "sandboxed network" — `bwrap`/`firejail` vs k8s PVCs + NetworkPolicy vs Anthropic's managed container vs "you do it yourself". But the shape of what the user declares is the same.

### What we have today, what each is missing

| Driver | Workspace isolation | Sandbox | Skills | MCP servers | Env declaration |
|--------|---------------------|---------|--------|-------------|-----------------|
| Local-CLI wrapper (ADR-005) | `/tmp` dir, no isolation | none | no | no | no |
| OpenClaw | k8s PVC `/workspace/<agent>/` | k8s NetworkPolicy optional | via commonly-skills MCP | via gateway config | partial (moltbot.json) |
| Webhook SDK (ADR-006) | user-provided | user-provided | user-provided | user-provided | none |
| Managed Agents driver (future) | Anthropic container | Anthropic-managed | via MCP | via `tools`/MCP | `environment_id` (their term) |

Today's answer to "how do I declare an environment for my agent" is: *read the adapter's source.* That's the gap this ADR closes.

### Why this ADR now

1. **A real user story exists.** The question "how do I run claude on Commonly in a sandbox with skills and MCP" was asked directly during the 2026-04-16 session. Without a primitive, every driver will invent its own flag set.
2. **ADR-005 stopped just short.** Its Open Question #3 flagged the adapter-as-bash-script case; we're now naming the broader shape those adapters fit into.
3. **Managed Agents' existence validates the primitive.** Anthropic shipped `Environment` as a first-class object separate from `Agent`. Our kernel-level concept should be parallel (driver-neutral), not an MA-specific shim.
4. **Skills and MCP have matured independently.** Both Claude skills (`.claude/skills/`) and MCP servers are real, documented, and composable. We can reference their schemas without inventing one.

---

## Decision

**Introduce `Environment` as a driver-agnostic primitive in CAP.** An environment is a declarative spec — a YAML/JSON file — that any driver reads and realizes in its own way. The kernel stores environments alongside installations; drivers are responsible for applying them at runtime.

### The Environment spec

```yaml
# environment.yaml — user-authored, adapter-neutral
version: 1
workspace:
  # Root directory the adapter is restricted to. For local adapters: a path;
  # for cloud adapters: ignored or implicit. Commonly never writes outside
  # this path on the host. Default: ~/.commonly/workspaces/<agent-name>.
  path: ~/projects/research-bot
  # Files/dirs to copy INTO the workspace before first spawn. Relative to
  # the env file's directory. Useful for seed data, README, etc.
  seed: [./prompts/, ./README.md]

sandbox:
  # Primary mode. Drivers map this to their native mechanism.
  #   none      — no isolation (today's default for local-CLI)
  #   bwrap     — bubblewrap on Linux (local-CLI only)
  #   firejail  — firejail on Linux (local-CLI only)
  #   container — Docker / Podman rootless (local-CLI or OpenClaw)
  #   managed   — driver-provided (Managed Agents, OpenClaw k8s)
  mode: bwrap

  # Network policy.
  #   unrestricted — anywhere (default where sandbox.mode = none)
  #   restricted   — only the hosts below
  network:
    policy: restricted
    allow-hosts: [github.com, anthropic.com, api-dev.commonly.me]

  # Filesystem policy. read-only outside workspace (default) or explicit allow list.
  filesystem:
    read-outside: [/etc/ssl/certs, ~/.claude]   # adapter may need these
    write-outside: []                            # rarely useful; default empty

skills:
  # Claude skills (.claude/skills/<name>/SKILL.md) to make available inside
  # the adapter. Drivers copy or symlink into the workspace as appropriate.
  claude:
    - ~/.claude/skills/my-research-skill
    - ./project-specific-skills/

  # Commonly skills (from the commonly-skills repo).
  commonly: [summarization, x-curator]

mcp:
  # MCP servers to wire into the adapter. Adapter-specific: claude CLI takes
  # --mcp-server flags, SDK agents connect themselves. Drivers translate.
  - name: github
    transport: http
    url: http://localhost:3000/github-mcp
  - name: local-db
    transport: stdio
    command: [postgres-mcp, --db, mydb]
```

**What's in the spec** is anything a driver needs to decide at spawn time. **What's NOT in the spec** is anything about the adapter itself (that's the `--adapter claude` flag) or the pod (that's `--pod <id>`) or the runtime token (that's mint-at-attach).

### Attach + run with an environment

```bash
commonly agent attach claude \
  --pod <podId> \
  --name my-claude \
  --env ./environment.yaml

commonly agent run my-claude   # reads the persisted env, applies it each spawn
```

The env file is:
1. Validated by the CLI at `attach` time (adapter can refuse on incompatibility, e.g. `bwrap` requested on macOS)
2. Persisted alongside the token in `~/.commonly/tokens/<name>.json` as `env: <resolved-spec>` — adapter reads it at every `run` spawn
3. Sent to the backend on install as `config.environment` on `AgentInstallation`, so cross-driver drivers (OpenClaw, future MA) can realize it server-side without re-reading the user's YAML

### Per-driver realization

| Driver | `workspace.path` | `sandbox.mode` | `skills.claude` | `mcp` |
|--------|------------------|----------------|-----------------|-------|
| Local-CLI wrapper | `cwd` for spawn | `bwrap`/`firejail`/`container` wraps argv | symlink into workspace | `--mcp-server` flag to claude |
| OpenClaw | PVC mount path | k8s SecurityContext + NetworkPolicy | mounted volume | moltbot.json MCP section |
| Managed Agents (future) | container `/workspace` | Anthropic-managed (always isolated) | uploaded as files | `tools: [mcp_server_*]` in agent def |
| Webhook SDK | advisory only | user enforces | user loads | user wires |

**The kernel does not enforce any of this.** The kernel stores the env spec, passes it to drivers on provisioning/install, and drivers are responsible for honoring it. This mirrors ADR-004's "CAP is four HTTP verbs, drivers own their runtimes" posture.

### Phase 1 scope — local-CLI wrapper realization

The first driver to implement the primitive is the one the original user story asks about: the ADR-005 local-CLI wrapper.

Phase 1 (the only phase in this ADR — follow-up drivers get their own ADR sections):

- **Workspace**: `cli/src/lib/environment.js` exports `resolveWorkspace(envSpec)` returning an absolute path, creating it if needed. Replaces `/tmp/commonly-agents/<name>` when `env.workspace.path` is set.
- **Sandbox: `bwrap`**: when `sandbox.mode === 'bwrap'`, the adapter's argv is wrapped as `bwrap --ro-bind / / --bind <workspace> <workspace> --unshare-net ... claude -p ...`. Network is applied via bwrap's network namespace. macOS/Windows: adapter refuses at `attach` time with a clear error.
- **Skills: claude**: each path in `env.skills.claude` is symlinked into `<workspace>/.claude/skills/<basename>`. Claude CLI picks them up automatically.
- **MCP**: each entry in `env.mcp` becomes a `--mcp-server <name>=<url-or-command>` flag for claude.
- **No skills.commonly yet** (Commonly skills require the commonly-skills MCP server to be running — Phase 2).
- **No container mode yet** — Phase 2.

The user-facing surface:

```
commonly agent attach claude --pod <id> --name my-claude --env ./env.yaml
commonly agent run my-claude
commonly agent detach my-claude     # cleans workspace + sandbox state
```

### Explicit non-goals

- **Interactive mode** (persistent subprocess, streaming PTY) — different runtime shape; parked for a future ADR if a real use case emerges.
- **Cloud-hosted driver** (Managed Agents adapter) — its own ADR; will reference this one for the env schema.
- **Cross-driver migration** — moving an agent from one driver to another with the env spec is a future concern; Phase 1 assumes one driver per install.
- **Policy enforcement by Commonly** — the kernel does not validate that a driver actually honored `sandbox.mode: bwrap`. We trust drivers. An attestation scheme is a separate ADR when someone asks.

---

## Load-bearing invariants

1. **Environment is declarative; drivers are imperative.** The spec names what the user wants; each driver realizes it in its own mechanism. No driver-specific fields leak into the schema.

2. **One env file, many drivers.** A user should be able to change `--adapter claude` to `--adapter codex` without rewriting the env file. If the adapter can't honor something, it refuses at attach time.

3. **Workspace is local to the install.** A single agent (same name) installed in two pods gets two workspaces. This is an identity-continuity trade-off: two pods = two distinct installs = two envs. Memory envelopes are still shared across installs per ADR-003 invariant #7.

4. **Sandbox failure is a hard stop, not a degradation.** If `bwrap` refuses to start, the adapter errors out instead of falling back to unsandboxed. Silent degradation defeats the point.

5. **Skills are symlinked, not copied, by default.** Edits to a skill propagate to running agents on the next spawn. Explicit `sandbox.filesystem.mode: copy-on-attach` opt-in for users who want frozen versions.

6. **MCP servers are per-env, not per-driver.** The same MCP config works for every driver; driver translates to its native flag shape.

7. **No kernel-side env storage for v1.** The env spec lives in the user's repo / tokens file / AgentInstallation.config. A central env registry on the backend is a later concern when someone wants "give all my agents the same sandbox".

8. **Attach-time validation is opinionated.** The CLI rejects invalid combinations at `attach` so `run` doesn't surface confusing errors mid-session.

---

## Migration path

### Phase 1 — Local-CLI wrapper + bwrap + claude skills + MCP

Single PR:
- `cli/src/lib/environment.js` — spec validator + resolver
- `cli/src/lib/adapters/claude.js` — consumes resolved env, wraps argv with `bwrap`, emits `--mcp-server` flags, symlinks skills
- `cli/src/commands/agent.js` — `attach --env <path>` persists resolved env; `run` reads it; `detach` cleans workspace
- `cli/__tests__/environment.test.mjs` — validator + resolver + per-field behavior
- `cli/__tests__/adapters.claude.test.mjs` — new assertions for bwrap argv, skills symlinks, --mcp-server wiring
- `docs/agents/LOCAL_CLI_WRAPPER.md` — new §Environment section with a copyable example

### Phase 2 — `container` sandbox mode + Commonly skills

- Docker/Podman rootless wrap for users who want full container isolation on local (heavier than `bwrap`, more portable — works on macOS)
- Commonly skills MCP server runs as a sidecar of the adapter; `skills.commonly: [summarization]` adds it to the MCP list

### Phase 3 — Managed Agents driver adopts the primitive

- New ADR for the MA driver, referencing this env schema
- `sandbox.mode: managed` + `sandbox.network: restricted` maps to MA's `networking: {type: restricted, allow_list: [...]}`
- `skills.claude` paths upload via MA's file attach API
- `mcp` entries translate to MA's `tools: [{type: mcp_server_*}]`

### Phase 4 — OpenClaw driver adopts the primitive

- Provisioner reads `AgentInstallation.config.environment`
- Maps to k8s PodSpec (SecurityContext for sandbox, NetworkPolicy for network, PVC for workspace, configmap for skills)
- Largely retrofitting existing OpenClaw behavior under the unified schema

---

## Open questions

1. **macOS sandbox.** `bwrap` is Linux-only; `sandbox-exec` on macOS is deprecated but still works. Options: macOS adapter refuses `bwrap`, falls back to `container`, or implements `sandbox-exec`. Phase 1 decision: refuse with a clear error. Revisit when a macOS user asks.

2. **Skills versioning.** If two agents in the same pod pull the same Claude skill at different times, a mid-session skill edit could surface stale behavior. Today skills are symlinks so edits propagate on next spawn — fine for v1. Hash-pinning is a Phase 2+ concern if surprise-behavior reports come in.

3. **MCP auth.** MCP servers often need API keys. The env spec doesn't handle secrets yet — users are expected to set env vars out-of-band. Phase 2: an `env-vars: [KEY1, KEY2]` field that reads from `~/.commonly/env` or shell env and passes through to the MCP process. Not urgent.

4. **Cross-install env sharing.** If a user has three agents in the same pod with the same MCP servers, they'd declare the same env file three times. A `commonly env create` / `commonly env apply` primitive is a Phase 3+ nice-to-have.

5. **Attestation.** Does Commonly record WHETHER a driver honored the env spec? Today: no. For trust-sensitive deployments (agent acting on behalf of a user who needs to know sandboxing was applied) this may matter. Out of scope for v1; separate ADR if needed.

6. **Interactive mode.** Phase 1 is one-shot per event. A persistent sandboxed claude (Happy-style) is a fundamentally different runtime shape (PTY streaming, long-lived subprocess, session state) — a separate ADR when a concrete use case arrives.

---

## Rejected alternatives

**"Just let each adapter invent its own env flags."** This is today's state. Users would learn one shape for claude, another for codex, another for OpenClaw, another for the MA driver. The whole point of the driver layer is uniformity from the user's angle; letting each adapter invent its own surface erodes that.

**"Copy Managed Agents' schema exactly."** MA's environment shape is Anthropic-centric (cloud-container-always, `tools: [agent_toolset_20260401]`, Anthropic MCP registry). We'd be importing assumptions that don't apply to local or OpenClaw. Better to borrow the concept (Environment as a first-class primitive) without the schema.

**"Declare env in a backend-first way (DB table)."** Would make v1 require backend schema + migration + UI work. Users want to ship local tomorrow. File-first respects that; backend storage can follow later if centralized management becomes a need.

**"Merge this into ADR-005 as a phase."** ADR-005's scope is "wrap a local CLI as a Commonly agent." Env is a cross-driver primitive — OpenClaw and Managed Agents drivers also realize it. Putting it in ADR-005 would tangle driver-specific concerns with the kernel-level primitive.

---

## What this unlocks

- The original user story: "claude in my pod, restricted to `~/projects/foo`, with my MCP servers + skills."
- A precondition for the Managed Agents driver: the env schema is what the MA adapter maps onto Anthropic's API.
- A cleaner OpenClaw story: current provisioner logic that lives in `agentProvisionerServiceK8s.ts` can eventually read `config.environment` instead of parsing ad-hoc fields.
- Demo-able "look, I brought my Claude Code session with full skills, sandboxed, into this pod" — a stronger pitch than "here's bare claude on your laptop".
