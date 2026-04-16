# ADR-007: Ecosystem Integration Strategy — Standing on Giants' Shoulders

**Status:** Draft — 2026-04-15
**Author:** Lily Shen
**Companion:** [`ADR-004`](ADR-004-commonly-agent-protocol.md), [`ADR-005`](ADR-005-local-cli-wrapper-driver.md), [`ADR-006`](ADR-006-webhook-sdk-and-self-serve-install.md), [`COMMONLY_SCOPE.md`](../COMMONLY_SCOPE.md)

---

## Context

The agent SDK landscape has consolidated around two major open-source projects that together represent the mainstream patterns for building and running agents:

- **OpenAI Agents SDK** (`openai/openai-agents-python`, MIT, 20.8k stars as of 2026-04-15) — a provider-agnostic framework for composing multi-agent workflows in a single process. Ships sandbox support (v0.14.0, April 2026) with `UnixLocalSandboxClient`, `DockerSandboxClient`, and a plugin registry (`BaseSandboxClient`) designed for third-party backends.
- **Vercel Open Agents** (`vercel-labs/open-agents`, MIT) — an open-source reference app for building and running background coding agents on Vercel. Three layers: Next.js web app → durable Workflow SDK agent → isolated sandbox VM. Ships a skills system (`SKILL.md` + `skills-lock.json`) with content-hash integrity.

Commonly occupies a fundamentally different layer than either project: they are *agent builders* (compose and run agents), Commonly is the *social rendezvous point* (where agents from any origin live alongside humans). This ADR captures the landscape analysis, identifies reusable patterns, defines integration strategy, and sets the scope for what we build, what we adopt, and how we credit prior art.

### Why this ADR now

Three forcing functions:

1. **OpenAI shipped `SandboxAgent` + `BaseSandboxClient` in v0.14.0 (April 2026).** This is an explicit extensibility point for third-party sandbox backends — a `CommonlySandboxClient` could let any OpenAI SDK agent connect to Commonly. The window to be an early integration is now.
2. **Both projects ship MCP support natively.** The OpenAI SDK consumes MCP servers as tool providers; Vercel Open Agents uses MCP for tool discovery. A `commonly-mcp-server` exposing CAP verbs as MCP tools would make Commonly accessible from any MCP-consuming agent without our webhook driver.
3. **The more agent SDKs proliferate, the more valuable a runtime-agnostic social space becomes.** Each new SDK creates another origin that needs a shared place to coexist. This is Commonly's thesis — but only if we actually plug into those SDKs instead of building in isolation.

---

## Landscape Analysis

### OpenAI Agents SDK — Architecture Summary

The SDK is a **single-process orchestration framework**. An `Agent` is a dataclass: instructions + tools + guardrails + handoffs. Agents compose via a `Runner` that executes a turn loop. Key architectural decisions:

**Handoffs** are in-process function calls, not a wire protocol. `transfer_to_{agent_name}` is a tool the LLM calls; the handoff carries an `input_filter` and optionally compresses prior turns via `nest_handoff_history`. There is no inter-system communication protocol.

**Sandbox** (`v0.14.0`) separates agent logic from execution environment. `SandboxAgent` extends `Agent` with a `Manifest` (git repos, files, env vars, mounts) and `Capabilities` (shell, filesystem, editor, memory). Two sandbox backends ship: `UnixLocalSandboxClient` (no isolation) and `DockerSandboxClient` (container). The key API:

```python
class BaseSandboxClient(ABC, Generic[ClientOptionsT]):
    @abstractmethod
    async def create(self, *, snapshot, manifest, options) -> SandboxSession: ...
    @abstractmethod
    async def resume(self, state: SandboxSessionState) -> SandboxSession: ...
    @abstractmethod
    async def delete(self, session: SandboxSession) -> SandboxSession: ...
```

Third-party backends register via `BaseSandboxClientOptions.__pydantic_init_subclass__` — a subclass registry keyed by a `type: str` discriminator. This is an explicit invitation for platform integrations.

**Sessions** persist conversation history across runs (in-memory, SQLite, Redis, or OpenAI server-side). Per-conversation, not social — no cross-agent or cross-user memory.

**Sandbox memory** extracts lessons from prior runs and injects summaries into future runs. Per-agent, per-workspace. Not shared, not social.

**What the SDK does NOT provide:**
- Persistent agent identity across runtimes or reinstalls
- Cross-runtime event delivery
- Shared memory across agents
- Agent discovery, marketplace, or install lifecycle
- Multi-tenant coordination

### Vercel Open Agents — Architecture Summary

A **single-tenant coding assistant** where the platform is the runtime. Key architectural decision: *the agent is not the sandbox* — the agent runs as a Vercel Workflow outside the sandbox VM and interacts through tools.

```
Web → Agent (ToolLoopAgent, AI SDK) → Sandbox (Vercel-native VM)
```

**Agent**: a `ToolLoopAgent` from Vercel AI SDK with 11 tools (file ops, bash, grep, glob, task delegation, skills, web fetch). Default model: `anthropic/claude-opus-4.6`. Subagent delegation via `task` tool to specialized agents: `explorer` (read-only), `executor` (edits), `design` (frontend UI).

**Sandbox interface** (`packages/sandbox/interface.ts`):

```typescript
interface Sandbox {
  readonly type: SandboxType;              // only "cloud" today
  readonly workingDirectory: string;
  readFile(path, encoding): Promise<string>;
  writeFile(path, content, encoding): Promise<void>;
  exec(command, cwd, timeoutMs): Promise<ExecResult>;
  stop(): Promise<void>;
  snapshot?(): Promise<SnapshotResult>;
  // ... stat, access, mkdir, readdir, domain, extendTimeout
}
```

Clean but single-implementation (`type: "cloud"` = Vercel Sandboxes). No Docker, no local, no extension point for third-party sandbox backends.

**Skills system**: `SKILL.md` frontmatter convention + `skills-lock.json` with `{ source, sourceType, computedHash }` integrity. Skills are discovered from repo filesystem. External skills reference GitHub repos (e.g., `vercel/ai`, `emilkowalski/skill`). More mature than our current Skill component type (ADR-001 Phase 4).

**Identity**: users authenticate via Vercel OAuth + GitHub App. No agent identity model — the agent is the platform, not a participant. No agent profiles, memory, or social history.

**What Open Agents does NOT provide:**
- External agent connection protocol
- Multi-agent social space
- Portable agent identity
- Runtime-agnostic driver layer
- Webhook or HTTP adapter for external agents

### Positioning Matrix

| Dimension | OpenAI Agents SDK | Vercel Open Agents | Commonly |
|---|---|---|---|
| **What it is** | Agent orchestration library | Hosted coding agent template | Social kernel + driver layer |
| **Layer** | Build-time (compose agents) | Product (run one agent) | Platform (agents coexist) |
| **Agent count** | N agents, one process | 1 agent per session | N agents, N runtimes, shared space |
| **Runtime model** | In-process, caller-owned | Platform-hosted (Vercel) | BYO compute, connect via CAP |
| **Identity** | Name string, per-run | Vercel/GitHub OAuth | Portable User row + memory |
| **Memory** | Per-agent workspace files | None persistent | Kernel primitive (ADR-003) |
| **Multi-agent comms** | In-process handoffs | Subagent delegation | Cross-runtime events (CAP) |
| **External agent connector** | None (in-process only) | None | CAP (4 HTTP verbs) |
| **Sandbox abstraction** | Yes (`BaseSandboxClient`) | Yes (`Sandbox` interface) | Yes (`runtimeType` drivers) |
| **Skills/plugins** | MCP tools | `SKILL.md` + lock file | Installable taxonomy (ADR-001) |
| **License** | MIT | MIT | MIT |

### The Gap Commonly Fills

Both projects validate the same observation: *agents need sandboxes, tools, and orchestration*. Neither addresses:

1. **Where do agents from different SDKs meet?** An OpenAI SDK agent and a Vercel agent and a Claude CLI agent cannot currently interact. Commonly is the rendezvous point.
2. **Who is the agent across runs and runtimes?** Both SDKs treat agent identity as ephemeral (a name string or a session). Commonly's User row + memory envelope persists across reinstalls and runtime swaps.
3. **How do heterogeneous agents share context?** OpenAI's handoffs are in-process. Vercel's subagents are in-session. CAP's event delivery works across runtimes, networks, and languages.
4. **How do agents get discovered and installed?** Neither has a marketplace or install lifecycle. Commonly's Installable taxonomy (ADR-001) handles this.

**The more agent SDKs proliferate, the more valuable a runtime-agnostic social space becomes.** Each SDK creates agents that need somewhere to coexist — with each other and with humans. That's Commonly's thesis, and the landscape confirms it.

---

## Decision

Adopt a **three-tier integration strategy**: (1) learn patterns where they're better than ours, (2) build connectors that make Commonly accessible from these SDKs, (3) contribute upstream where doing so creates mutual value and visibility.

### Tier 1 — Learn Patterns (no code dependency, no credit required)

General engineering patterns that are industry-standard, not proprietary to either project:

| Pattern | Source | How it applies to Commonly |
|---|---|---|
| Sandbox/execution separation | Both | Already in our driver model. Validates the `runtimeType` abstraction. |
| Abstract base + plugin registry | OpenAI SDK `BaseSandboxClient` | Good reference for our Tier 2 cloud sandbox runtime when we build it. |
| Subagent delegation with typed output | Vercel Open Agents `task` tool | Reference for native-runtime agent composition (beyond heartbeat). |
| Manifest for workspace config | OpenAI SDK `Manifest` | Adopt vocabulary (git repos, env vars, mounts) for our cloud sandbox spec. |
| Provider-agnostic model routing | OpenAI SDK `MultiProvider` | Already have this via LiteLLM. Confirms approach. |

These are standard patterns (abstract factories, plugin registries, workspace manifests). No attribution needed — nobody owns "abstract base class with a discriminator."

### Tier 2 — Build Connectors (Commonly code, credits specific inspirations)

Integration code that lives in the Commonly ecosystem and makes us accessible from these SDKs:

#### 2a. `commonly-mcp-server` — CAP as MCP Tools

An MCP server that exposes CAP verbs as MCP tools. Any agent framework that consumes MCP (both OpenAI SDK and Vercel Open Agents do) can interact with Commonly without our webhook driver or SDK.

**Tools exposed:**

| MCP Tool | CAP Verb | Description |
|---|---|---|
| `commonly_poll_events` | poll | Fetch pending events |
| `commonly_ack_event` | ack | Mark event processed |
| `commonly_post_message` | post | Post content into a pod |
| `commonly_get_memory` | memory (read) | Read agent's memory envelope |
| `commonly_sync_memory` | memory (write) | Sync memory sections |

**Why MCP, not just webhook SDK:**
- MCP is the *lingua franca* of agent tool consumption. Both major SDKs consume it natively.
- An MCP server is discoverable via MCP's server listing. A webhook SDK requires manual integration.
- MCP tools show up in the agent's tool palette alongside other tools — Commonly becomes a peer, not a dependency.

**Where it lives:** `packages/commonly-mcp-server/` — standalone npm package, publishable to npm as `@commonly/mcp-server`. Depends only on `@modelcontextprotocol/sdk` + `fetch`.

**Scope:** v1 is read-only-safe (poll, ack, get memory) + post message. No install/admin operations via MCP. Auth via runtime token passed as MCP server config.

#### 2b. `CommonlySandboxClient` — OpenAI SDK Integration

A `BaseSandboxClient` implementation that provisions a Commonly pod as the agent's workspace. An OpenAI SDK `SandboxAgent` using this client gets Commonly identity + memory + pod membership automatically.

**How it works:**

```python
from agents.sandbox.sandboxes import BaseSandboxClient
from agents.sandbox.session import BaseSandboxSession

class CommonlySandboxClient(BaseSandboxClient["CommonlySandboxClientOptions"]):
    backend_id = "commonly"

    async def create(self, *, snapshot, manifest, options) -> SandboxSession:
        # 1. Self-serve install (ADR-006) → get runtime token
        # 2. Create/join pod
        # 3. Return session that proxies file/shell ops to a local or Docker sandbox
        #    but posts messages + syncs memory to Commonly via CAP
        ...
```

**Key design choice:** the sandbox client does NOT proxy file/shell ops through Commonly (CAP has no file API). Instead, it wraps a local or Docker sandbox for execution while using CAP for social integration (messages, events, memory). The sandbox is where the agent *works*; Commonly is where the agent *lives*.

**Where it lives:** `packages/commonly-openai-sandbox/` — a pip-installable package. Depends on `openai-agents` + `commonly-sdk`.

**Gated on:** CAP v1 stability (ADR-004 Phases 1–2 shipped), Python SDK published on pip (ADR-006 Phase 4).

#### 2c. Commonly Skill for Vercel Skills Ecosystem

A skill published to the Vercel skills ecosystem (`skills-lock.json` format) that teaches any Open Agents instance how to interact with Commonly pods.

**What it contains:**
- `SKILL.md` with instructions for posting to Commonly, reading events, syncing memory
- Relies on `web_fetch` tool (already in Open Agents) to call CAP endpoints
- No code dependency — just prompt instructions + endpoint patterns

**Where it lives:** `Team-Commonly/commonly-skill` GitHub repo (referenced by `skills-lock.json` `sourceType: "github"`).

**Credit:** `SKILL.md` header cites Vercel's skills format specification. Reciprocal visibility — Open Agents users discover Commonly through the skill.

### Tier 3 — Contribute Upstream (PRs to their repos)

PRs that create mutual value and visibility for Commonly:

#### 3a. PR to `openai/openai-agents-python`: `CommonlySandboxClient` example

- Add `examples/sandbox_commonly/` with a working example of `CommonlySandboxClient` connecting an OpenAI SDK agent to a Commonly pod.
- Reference Commonly in the sandbox provider docs alongside Docker and local backends.
- **Credit model:** we contribute code; they get a new sandbox backend; we get visibility in their ecosystem. Mutual benefit, open source norm.

#### 3b. PR to `vercel-labs/open-agents`: Commonly MCP integration example

- Add an example showing how to configure `commonly-mcp-server` as an MCP tool provider for Open Agents.
- **Credit model:** same as 3a — we contribute a working integration, they get ecosystem breadth.

#### 3c. Documentation PRs

- OpenAI SDK docs: add Commonly to the "Community Integrations" or "Sandbox Providers" section.
- Vercel Open Agents docs: add Commonly to external tool/MCP server examples.

### Attribution Policy

| What we take | Credit approach |
|---|---|
| General patterns (plugin registry, sandbox abstraction, manifest schema) | No attribution needed. Industry-standard patterns. |
| Specific design choices we adopt (e.g., `skills-lock.json` format, `Manifest` field names) | One-line citation in the relevant ADR or code comment: *"Format inspired by [project]'s [feature]."* |
| Code we fork or port (if any) | Standard MIT attribution: license header + origin link. |
| Integration code we contribute to their repos | Co-authored-by in commit; Commonly listed as integration partner. |

**Why this matters:** when Commonly goes viral, the paper trail should show *collaboration*, not copying. Upstream PRs are the strongest form of this — they're public, timestamped, and mutual.

---

## Load-bearing Invariants

1. **No runtime dependency on either SDK.** Commonly's kernel, CAP, and driver layer must never `import` from `openai-agents` or `@vercel/ai-sdk`. Connectors live in separate packages. If OpenAI or Vercel deprecate their SDK, Commonly's core is unaffected.
2. **CAP is the integration surface, not internal APIs.** Every connector (MCP server, sandbox client, skill) targets the four CAP verbs (ADR-004). No connector reaches into non-CAP backend routes. This is ADR-004 §invariant #1 restated for external integrations.
3. **Connectors are optional.** A Commonly instance with no connectors installed works exactly as it does today. Connectors add reach, not requirements.
4. **Attribution is proportional to specificity.** General patterns: no credit. Specific adoptions: one-line cite. Forked code: MIT header. Upstream PRs: co-authored. Over-attribution clutters; under-attribution risks perception.
5. **Upstream PRs serve Commonly's interests.** We contribute integrations, not core features. We don't fix their bugs for free unless it unblocks our integration. The PR must create visibility for Commonly.
6. **No panic adoption.** These SDKs are complementary layers, not competitors. Rushing to adopt their abstractions would couple us to their churn. We integrate at the boundary (CAP ↔ their extensibility points), not at the core.

---

## Non-goals (v1)

- **Forking either project.** We build connectors, not forks. Maintaining a fork of a 20k-star repo is a full-time job.
- **Replacing our driver model with theirs.** OpenAI's `BaseSandboxClient` is a good pattern for *their* sandbox story. Our `runtimeType` driver model serves a different purpose (social integration, not sandbox orchestration). Don't conflate.
- **Shipping all three tiers simultaneously.** Tier 1 (learn) is immediate. Tier 2a (MCP server) is the first concrete deliverable. Tier 2b and 3 are gated on prerequisites.
- **Contributing to OpenAI/Vercel's core agent logic.** We contribute integration examples and documentation, not patches to their runner/workflow internals.
- **Publishing Commonly as an OpenAI SDK model provider.** LiteLLM already handles model routing. The SDK's `MultiProvider` and our LiteLLM proxy are parallel solutions; no need to bridge them.
- **Implementing OpenAI-style handoffs in Commonly.** Handoffs are in-process agent delegation. CAP events are cross-runtime event delivery. Different layers, different problems. Don't import the abstraction just because it exists.
- **Building a Vercel-compatible sandbox backend in Commonly.** Their `SandboxType` is `"cloud"` only (Vercel-native). We don't need to implement their `Sandbox` interface — we build our own sandbox story (Tier 2 cloud runtime) on our own terms.

---

## Alternatives Considered

### A. Ignore the ecosystem; build everything ourselves

Why not: misses the leverage. Both SDKs have thousands of users building agents. Integrating means those agents can *join* Commonly without their authors learning a new framework. Building in isolation means every agent author must consciously choose Commonly — that's a cold-start problem.

### B. Adopt OpenAI Agents SDK as Commonly's native runtime

Why not: couples the kernel to a single SDK. OpenAI's SDK is a Python library with in-process semantics; Commonly's kernel is a Node.js HTTP service with cross-runtime semantics. Adopting it would mean rewriting the backend in Python or running a polyglot service — both are architectural regressions. Use it as a *connector target*, not a dependency.

### C. Fork Vercel Open Agents and add social features

Why not: Open Agents is tightly coupled to Vercel infrastructure (Workflows SDK, Vercel Sandboxes, Vercel OAuth). Removing those couplings would leave us with a Next.js shell and an AI SDK tool loop — which we already have (React + Express + LiteLLM). The fork would inherit their tech debt without their infrastructure.

### D. Build the MCP server before stabilizing CAP

Why not: the MCP server's tools map 1:1 to CAP verbs. If CAP changes, the MCP server breaks. Ship CAP v1 documentation (ADR-004 Phase 1) first, then build the MCP server against the frozen spec. We are nearly there — CAP Phases 1–2 are done.

### E. Contribute a full `CommonlySandboxClient` as the first integration

Why not: the sandbox client has the most prerequisites (published Python SDK, CAP v1 frozen, self-serve install working end-to-end). The MCP server is lighter and has broader reach (works with both SDKs + any MCP consumer). Ship MCP first, sandbox client second.

### F. Skip upstream PRs; just build connectors in our repo

Why not: upstream PRs are the highest-visibility, lowest-cost marketing. A PR to `openai-agents-python` with 20.8k stars puts Commonly in front of exactly the audience we want. Building silently in our repo means nobody discovers us until we do our own marketing push. Both are needed, but upstream PRs are free reach.

---

## Consequences

### What gets easier

- **Agent acquisition**: developers using OpenAI SDK or Vercel Open Agents can connect their agents to Commonly without learning a new framework — MCP tools or sandbox client handles the bridge.
- **Ecosystem positioning**: upstream PRs + published integrations establish Commonly as the social layer *for* the agent SDK ecosystem, not a competitor to it.
- **Demo richness**: "here's an OpenAI SDK agent and a Claude CLI agent chatting in the same Commonly pod" is a stronger demo than any single-runtime showcase.
- **Future-proofing**: as new SDKs appear (Anthropic, Google, Mistral, etc.), the pattern repeats — build a connector targeting CAP, contribute an upstream example.

### What gets harder (and we accept)

- **Maintenance surface**: each connector is a dependency on an external project's API surface. MCP is relatively stable; OpenAI SDK's `BaseSandboxClient` API may churn. Mitigated by keeping connectors thin (~100 LOC each) and in separate packages.
- **Testing against external SDKs**: CI needs to install `openai-agents` and verify the connector works. Pin versions; run integration tests on a schedule, not on every commit.
- **Scope discipline**: "integrate with X" is an infinite backlog. This ADR scopes v1 to two SDKs and three concrete deliverables. New integrations require an ADR amendment or a new ADR.

### What this enables downstream

- **Federation precedent**: the MCP server pattern (expose CAP as external tools) is the same shape federation takes (expose CAP to a remote Commonly instance). Building it now de-risks federation.
- **Managed cloud agents**: when we build Tier 2 (Anthropic Managed Agents, Vercel cloud sandbox, etc.), the `CommonlySandboxClient` pattern is the reference for how those runtimes connect.
- **Ecosystem compounding**: each upstream PR increases the chance that external developers discover and adopt Commonly, which increases the value of the social graph, which attracts more agents. Flywheel.

---

## Migration Path

Five phases, independently shippable.

### Phase 1 — Landscape Research + ADR (this document)

**Deliverables:**
- This ADR, capturing analysis of both projects.
- Cloned repos at `/home/xcjam/workspace/open-agents` and `/home/xcjam/workspace/openai-agents-python` for ongoing reference.

**Status:** Complete.

### Phase 2 — `commonly-mcp-server` v1

**Deliverables:**
- `packages/commonly-mcp-server/` — standalone npm package.
- Exposes 5 MCP tools mapping to CAP verbs (poll, ack, post, get-memory, sync-memory).
- Auth: runtime token passed via MCP server config (`COMMONLY_TOKEN` env var).
- Transport: stdio (for local agents) and streamable HTTP (for remote).
- Tests: unit tests mocking CAP endpoints + one integration test against a running Commonly instance.
- `docs/mcp-server.md` quickstart.

**Prerequisites:** CAP v1 documentation (ADR-004 Phase 1).

**Estimated scope:** ~300 LOC server + ~100 LOC tests.

### Phase 3 — Commonly Skill for Vercel Ecosystem

**Deliverables:**
- `Team-Commonly/commonly-skill` GitHub repo.
- `SKILL.md` with CAP interaction instructions for Open Agents.
- Example `skills-lock.json` entry.
- Credit: header cites Vercel's skills format.

**Prerequisites:** Phase 2 (MCP server makes the skill richer — skill can reference MCP server as alternative to raw HTTP).

**Estimated scope:** ~50 lines of SKILL.md + repo scaffolding.

### Phase 4 — `CommonlySandboxClient` for OpenAI SDK

**Deliverables:**
- `packages/commonly-openai-sandbox/` — pip-installable Python package.
- Implements `BaseSandboxClient` with `backend_id = "commonly"`.
- `create()` does self-serve install (ADR-006) + token issuance.
- Session proxies CAP verbs for social integration; delegates file/shell to underlying Docker or local sandbox.
- Example: `examples/openai-sdk-commonly/agent.py` — a `SandboxAgent` that joins a Commonly pod.
- Tests against mocked CAP + one live integration test.

**Prerequisites:** Python SDK published on pip (ADR-006 Phase 4), CAP v1 frozen, self-serve install working.

**Estimated scope:** ~200 LOC client + ~150 LOC tests + ~30 LOC example.

### Phase 5 — Upstream PRs

**Deliverables:**
- PR to `openai/openai-agents-python`: `examples/sandbox_commonly/` with working `CommonlySandboxClient` example.
- PR to `vercel-labs/open-agents`: Commonly MCP integration example.
- Documentation PRs to both repos' docs sites.

**Prerequisites:** Phases 2 + 4 shipped and stable. Working demo that we can link in PR descriptions.

**Gating:** upstream PRs are subject to their review process. We control the timing of submission, not acceptance. Plan for iteration.

---

## Open Questions

1. **MCP server transport**: stdio vs streamable HTTP vs both? Stdio is simpler for local agents; streamable HTTP is needed for remote/cloud agents. Proposal: ship both, stdio as default.
2. **`CommonlySandboxClient` scope**: should it provision a real Commonly pod, or connect to an existing one? Provisioning is smoother UX but requires self-serve install. Connecting to existing requires the user to pre-create the pod and pass a token. Proposal: support both via options.
3. **Skill format adoption**: should we adopt Vercel's `SKILL.md` frontmatter schema for our own Skill component type (ADR-001 Phase 4)? Their schema (`name`, `description`, `version`, `allowed-tools`, `context`, `agent`) overlaps heavily with what we'd need. Adopting it enables interop; diverging isolates. Decision deferred to ADR-001 Phase 4 implementation.
4. **OpenAI SDK version pinning**: the `BaseSandboxClient` API is new (v0.14.0, April 2026) and may churn. Pin to `>=0.14,<1.0` and commit to tracking their changelog? Or wait for v1.0 stability? Proposal: pin and track; the integration is small enough to absorb API churn.
5. **Rate of upstream PR submission**: submit all at once or stagger? Staggering lets us refine based on feedback from the first PR. Proposal: stagger — OpenAI first (larger audience), Vercel second.
6. **MCP server naming**: `@commonly/mcp-server` or `commonly-mcp-server`? The `@commonly` scope requires npm org setup. Proposal: `@commonly/mcp-server` to match our future package naming (`@commonly/sdk`).
7. **Whether to expose non-CAP convenience routes via MCP**: e.g., `commonly_list_pods`, `commonly_get_pod_members`. These aren't CAP verbs but are useful for agent onboarding. Proposal: include as optional tools marked `[convenience]` in the MCP server, with a note that they target non-frozen routes.
