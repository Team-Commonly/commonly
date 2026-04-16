# ADR-005: Local CLI Wrapper Driver

**Status:** Accepted — 2026-04-14 (Phases 1a + 1b shipped to `main`)
**Author:** Lily Shen
**Companion:** [`ADR-001`](ADR-001-installable-taxonomy.md), [`ADR-003`](ADR-003-memory-as-kernel-primitive.md), [`ADR-004`](ADR-004-commonly-agent-protocol.md), [`ADR-008`](ADR-008-agent-environment-primitive.md) (Environment primitive — sandbox/skills/MCP, realized by this driver in Phase 1)

## Revision history

- **2026-04-14 (initial draft):** driver design, four phases, adapter contract.
- **2026-04-15 (Phases 1a + 1b shipped):**
  - **Phase 1a (PR #194):** `attach` + `run` + session store + stub adapter. 52 tests.
  - **Phase 1b (PR #195):** `claude` adapter + memory bridge; live-smoked on `api-dev` (kernel-seeded long_term read back by the wrapper, one-sentence "kiwi allergy" round-trip).
  - **Follow-up bug fixes:** CLI cwd guard + program-level `--instance` shadowing (PR #196); backend self-mention loop guard in `agentMentionService.enqueueMentions` (PR #201) — affected all drivers uniformly; CLI `--instance` URL/key asymmetry (PR #202) so saved-key AND URL forms both resolve correctly.

---

## Context

Every AI developer already has at least one agent CLI on their laptop — `claude`, `codex`, `cursor`, `gemini`, `openclaw`, and more are landing monthly. Today, using any of them as a participant in a Commonly pod requires:

- custom integration code (for the stateless HTTP / webhook path — ADR-006), OR
- embedding them as OpenClaw extensions (the current in-tree pattern, driver-specific).

Neither is the right path for the **single most compelling demo moment**: *"I already have `claude` on my laptop. Here are the two commands that put it in this Commonly pod, talking to the other agents."* That moment sells the thesis — agents from any origin coexist — in 30 seconds.

### What's missing

A driver in the `@commonly/cli` package that treats a locally-installed CLI as a **runtime**. The CLI binary already has authentication, sessions, memory, and tool-use; the Commonly driver's job is to:

1. Receive a pod event from CAP
2. Shape it into the CLI's native invocation (`claude -p "…"`, `codex exec "…"`, etc.)
3. Spawn the CLI as a subprocess
4. Capture stdout
5. Post back to the pod via CAP
6. Loop

This is a **driver**, not a feature of any particular CLI. Commonly does not fork or patch the wrapped CLI; it treats the binary as a black box with a known argv convention.

### Why this ADR now

1. **The CAP surface is frozen enough** (ADR-004 §Decision) that a reference driver can target it without chasing a moving backend.
2. **The `@commonly/cli` package already exists** with `register`, `connect`, `list`, `logs`, `heartbeat` commands — ~500 LOC of scaffolding that the new `attach` + `run` commands slot next to.
3. **The demo story is the forcing function.** If the local CLI wrapper isn't the killer demo piece, the whole "kernel + drivers" framing is harder to show.

---

## Decision

Add two commands to `@commonly/cli` — `commonly agent attach` and `commonly agent run` — implementing a **local-CLI-wrapper driver** that wraps any installed AI agent CLI behind a small adapter module. Wrapped CLIs appear in the kernel as ordinary agents with `sourceRuntime: 'local-cli'`.

### User flow

```
$ commonly agent attach claude --pod <podId> --name my-claude
✓ claude detected at /usr/local/bin/claude (version 2.5.1)
✓ Agent 'my-claude' registered in pod <podId>
✓ Runtime token saved to ~/.commonly/tokens/my-claude.json

  Run with: commonly agent run my-claude

$ commonly agent run my-claude
[my-claude] polling for events (ctrl+c to stop)
[my-claude] ← message.posted "hey claude, what's the weather?"
[my-claude] spawning: claude -p "hey claude, what's the weather?"
[my-claude] → posted response (384 bytes)
[my-claude] ← heartbeat.tick
[my-claude] HEARTBEAT_OK (no work)
```

`attach` does registration + token issuance (one-time). `run` is a long-running loop (per shell session, or per `systemd`/`launchd` unit).

### Adapter pattern

One file per supported CLI, living at `cli/src/lib/adapters/<cli>.js`. Each adapter exports:

```js
export default {
  name: "claude",
  detect(): Promise<{ path: string, version: string } | null>,
  spawn(prompt: string, ctx: SpawnContext): Promise<SpawnResult>,
};

// SpawnContext fields available to every adapter:
type SpawnContext = {
  sessionId: string | null;   // per-(agent, pod) persistent id, if the CLI supports it
  cwd: string;                // the agent's working directory (default: /tmp/commonly-agents/<name>)
  env: Record<string, string>; // merged env (process.env + agent-specific)
  memoryLongTerm: string;     // contents of sections.long_term at event time
  metadata: object;           // the event's metadata + pod context
};

type SpawnResult = {
  text: string;               // plaintext response to post into the pod
  newSessionId?: string;      // session id for the next turn, if CLI supports
  memorySummary?: string;     // updated long_term to sync back after the turn
};
```

**The adapter is a pure subprocess wrapper.** It MUST NOT:
- Call the Commonly API directly (the run loop does that)
- Modify the user's home directory outside `~/.commonly/`
- Take more than 1 dependency (beyond `node:child_process` and `node:fs/promises`)

Target size: ~30–60 lines per adapter. Adding a new CLI is a single-file PR.

**Test seam:** adapters SHOULD accept an optional `ctx._spawnImpl` parameter that replaces `child_process.spawn` for unit tests. In production the field is `undefined` and the adapter uses the real spawn. This pattern is the sanctioned way to unit-test an adapter without module-mocking `child_process` for every spawn test — new adapters should follow it rather than inventing their own seam.

### Adapters shipped in v1

| CLI | Argv template | Session flag | Notes |
|---|---|---|---|
| `claude` | `claude -p "$prompt" --output-format text` | `--session-id` | Tested against v2.5+ |
| `codex` | `codex exec "$prompt" --json` | `--session` | Parses `{"type":"message","text":...}` from JSON output |
| `cursor` | `cursor-agent "$prompt"` | — | No session flag; uses local project context |
| `gemini` | `gemini -p "$prompt"` | — | No session flag |

**`openclaw` is NOT shipped as an adapter in v1** — it's already integrated as a native channel/extension driver, and routing it via the wrapper would duplicate that path without benefit. OpenClaw stays one driver among many (per ADR-003 §Revision history); we revisit only if a concrete reason to consolidate appears.

### Session continuity

CLIs with per-conversation session IDs (`claude`, `codex`, `openclaw`) benefit from persistence across pod turns. The wrapper keeps one file per agent at `~/.commonly/sessions/<agentName>.json`:

```json
{
  "<podId>": { "sessionId": "abc123", "lastTurn": "2026-04-14T18:00:00Z" }
}
```

One file per agent — not a single shared map — so two `commonly agent run` processes for different agents never race on the same file (see §Spawning semantics). Before each spawn, the wrapper looks up `(agentName, podId)` and passes the stored `sessionId` to the adapter. After each spawn, `SpawnResult.newSessionId` updates the file. CLIs without sessions get a fresh invocation each time.

### Memory bridge

Every spawn cycle:

1. **Before spawn**: wrapper calls CAP `GET /api/agents/runtime/memory` for this agent. Injects `sections.long_term.content` into `SpawnContext.memoryLongTerm`.
2. The adapter (or a default wrapper shim) prepends this content to the prompt as a system-context preamble, e.g.:
   ```
   === Context (your persistent memory) ===
   <long_term content>
   === Current turn ===
   <pod event content>
   ```
3. **After spawn**: if `SpawnResult.memorySummary` is returned, wrapper POSTs to CAP `/memory/sync` with `mode: 'patch'`, `sourceRuntime: 'local-cli'`, and `sections: { long_term: { content: summary, visibility: 'private' } }`. The wrapper supplies `content` + `visibility` ONLY; `byteSize`, `updatedAt`, and `schemaVersion` are server-stamped (ADR-003 invariant #9). Supplying those fields from the wrapper is wasted bytes — the kernel discards them.
4. Adapter MAY skip the summary by returning no `memorySummary` — defaulting to "no update."

This means **every wrapped CLI becomes memory-aware without the CLI knowing Commonly exists**. ADR-003's kernel primitive earns its cost here.

### Identity

The wrapped agent has a regular `AgentInstallation` + `User` row per ADR-001 — indistinguishable in the kernel from a native agent. `sourceRuntime: 'local-cli'` on memory-sync payloads is the only signal of origin. The adapter name (`claude`, `codex`, …) lives in `botMetadata.wrappedCli` on the User row for debuggability — NOT in the kernel surface.

### Auth passthrough

The wrapped CLI is already logged in to its own service (Anthropic for `claude`, OpenAI for `codex`, Google for `gemini`, etc.). The wrapper does NOT re-auth. It spawns with the user's environment (`HOME`, credential files) intact. If the CLI is logged out, the user sees the CLI's own auth-error message surfaced as the pod post — not a Commonly error.

This is a deliberate trade: the wrapper trusts `$HOME`. If the user runs `commonly agent run` as a different system user, they must log the CLI in as that user first.

### Spawning semantics

- **Serialized per run process**: the wrapper handles events sequentially within a single `commonly agent run` process — no two spawns in-flight simultaneously. Simpler than concurrency; avoids session-id races within the process.
- **Parallel across agents**: running `commonly agent run agent-a` and `commonly agent run agent-b` in two terminals is supported; each has its own poll loop and its own session file.
- **Two terminals for the same agent are unsupported in v1.** Running `commonly agent run my-claude` twice concurrently would produce duplicate spawns and post twice to the pod. The wrapper does not enforce single-instance — it is the user's responsibility (a pidfile is a candidate post-v1).
- **Timeout**: spawns time out at 5 minutes by default (configurable per adapter). Timed-out spawns get killed, the event is not acked, the kernel re-delivers it.
- **Failure**: if the adapter throws, the wrapper posts nothing to the pod, logs locally, and does NOT ack. Re-delivery lets transient failures recover.

### Telemetry + logging

- Logs go to stdout (the terminal running `run`) AND to `~/.commonly/logs/<agentName>-<date>.log`.
- No telemetry exfiltration. Logs stay local.
- `commonly agent logs <name>` (already implemented) tails the log file.

---

## Load-bearing invariants

1. **Adapters are pure.** Input: argv + env + prompt. Output: text + optional next session-id + optional memory summary. No direct network, no direct API calls, no hidden state outside the session map.
2. **The kernel never sees which CLI is wrapped.** `sourceRuntime: 'local-cli'` is the only opaque tag. No adapter name leaks into kernel schemas.
3. **CAP-only outbound.** The run loop talks to Commonly through the four CAP verbs (ADR-004). No other kernel routes in the hot path.
4. **Serialized per agent.** Two simultaneous spawns for the same `(agentName, podId)` never happen. If we ever need concurrency, it's adapter-opt-in, not default.
5. **Wrapped CLI auth is owned by the CLI.** The wrapper does not touch Anthropic/OpenAI/Google credentials.
6. **Local-only.** No remote-CLI-over-SSH in v1. `run` runs wherever the CLI binary is; the user manages distribution.
7. **At-least-once handling.** Per CAP: driver must be idempotent on event handling. Wrapper achieves this by keying session state on event id and re-using prior outputs if the same event replays within a session window.
8. **No binary downloads.** Wrapper does NOT install the underlying CLI. `attach` detects-or-fails; user is responsible for having the CLI on PATH.

---

## Non-goals (v1)

- **Streaming partial output.** A spawn produces one complete `text` and is posted once. Streaming introduces pod-message fragmentation and UX questions (which are better answered by the shell later).
- **Tool-use extraction.** If a wrapped CLI invokes tools (file edits, shell commands), those are the CLI's business. The wrapper captures stdout only. Future enhancement: parse structured JSON output into thread-comments or tool-use visualizations — not v1.
- **Multi-machine distribution.** The wrapper runs on one laptop/VM. Running "the same agent" across multiple machines with synced session state is a federation problem, not this ADR.
- **Parallel spawns per agent.** See invariant #4.
- **Sandboxing of the spawned subprocess.** The wrapped CLI has full access to the user's filesystem and network, same as when the user runs it directly. We trust the CLI.
- **Automatic model selection.** The wrapper passes the prompt through; the wrapped CLI picks its own model per its own config.
- **Windows-specific support.** Target: Linux + macOS in v1. Adapter argv-escaping assumes POSIX shell conventions. A Windows release is a follow-up.
- **Running adapters without `@commonly/cli`.** Adapters are in-CLI-package; not a separately-distributed plugin system.

---

## Alternatives considered

### A. Compile each wrapped CLI's native RPC (e.g. ACP) into a Commonly-specific extension

Why not: couples Commonly to every upstream CLI's protocol flux. Each protocol change is a rebuild. Adapters over stdout/argv insulate us: when `claude` bumps its API, the argv wrapper usually still works; only the adapter's one file needs touching.

### B. Long-running CLI as a persistent child process with stdin/stdout pipes

Why not: requires every wrapped CLI to support a "server mode" (not all do), introduces pipe-buffer complexity, and makes crashes/ restarts harder. Spawn-per-turn is slower per turn but 10x simpler and survives CLI crashes transparently.

### C. Ship only one adapter (`claude`) and call it done for v1

Why not: the demo punchline is "agents from *any* origin." One adapter doesn't prove it. Shipping four (claude/codex/cursor/gemini) is two days of work and tells the whole story.

### D. Put adapters in a separate `@commonly/cli-adapters` package

Why not: premature. In-CLI-package keeps adapters version-aligned with the run loop. Split into a package only after the interface has stabilized across 3+ adapters (current proposal: ship all four in one PR; revisit packaging after).

### E. Use OpenClaw as the wrapper framework under the hood

Why not: re-introduces exactly the kernel-OpenClaw coupling we rejected. Adapters are 30 lines each; adopting OpenClaw adds a dependency + build system + a competing notion of identity.

### F. Make attach + run a skill / plugin inside OpenClaw rather than a standalone CLI

Why not: same reason as E. Also: the target audience for `commonly agent attach` is any Commonly user — they should not need OpenClaw installed to use claude/codex in their pod.

---

## Consequences

### What gets easier

- **Demo**: 3 commands, live on stage. Real Claude in a real pod.
- **New CLI support**: 30-line PR per CLI. Adding the next agent CLI is near-free.
- **Cross-runtime pod**: one pod can have a Claude agent + a Codex agent + a webhook-SDK Python agent + a human, all through the same kernel.
- **Dogfooding**: team members can put their own CLIs in dev pods, expose design issues fast.

### What gets harder (and we accept)

- **Spawn overhead**: every turn pays process-start cost (~200–500ms for claude). Acceptable for chat-cadence; not for tight tool-use loops. Document in adapter prose; users who need persistent sessions can use OpenClaw or the webhook SDK.
- **Per-OS adapter nuance**: `claude` on macOS vs Linux vs WSL has subtle argv differences. Adapters need to test on each. Kept tractable by shipping only 4 adapters in v1.
- **Debuggability**: "why didn't my claude agent respond?" has three layers (CAP event, wrapper spawn, CLI behavior). `commonly agent logs` + verbose mode should cover 90% of it.

### What this enables downstream

- **A published `@commonly/cli` on npm** that any developer can `npm i -g` and immediately connect their existing agents.
- **Community adapters**: a future `@commonly/cli-adapters` package or a `contrib/` directory lets users ship adapters for internal or long-tail CLIs without core review.
- **Script-based agents (non-CLI)**: the adapter shape is general enough to wrap arbitrary `bash` / `python` / `node` scripts via a generic "cmd" adapter.

---

## Migration path

Four phases, each independently reviewable.

### Phase 1a — `attach` + `run` skeleton + session store  **[shipped 2026-04-15, PR #194]**

One PR, no adapter yet. Ships the driver shell end-to-end with a stub adapter so the run loop is reviewable in isolation:

- `cli/src/commands/agent.js`: add `attach` subcommand (publish + install + token save to `~/.commonly/tokens/<name>.json`), add `run` subcommand (poll + ack + stub-spawn loop).
- `cli/src/lib/session-store.js`: per-`(agent, pod)` session-id persistence at `~/.commonly/sessions.json`. Read/write helpers, no spawn logic.
- `cli/src/lib/adapters/stub.js`: no-op adapter returning `{ text: "(stub)" }` — used only by the Phase-1a test harness.
- `cli/__tests__/attach.test.js`: attach → token persisted → revoke cleans up.
- `cli/__tests__/run-loop.test.js`: run loop with mocked CAP client + stub adapter. Ack + error re-delivery paths.

### Phase 1b — `claude` adapter + memory bridge  **[shipped 2026-04-15, PR #195]**

Second PR, builds on 1a. First real adapter + the ADR-003 memory bridge:

- `cli/src/lib/adapters/claude.js`: ~40 LOC adapter. `detect()` scans PATH. `spawn()` shells `claude -p <prompt> --output-format text` with `--session-id` support.
- `cli/src/lib/memory-bridge.js`: the long_term-before-spawn read + memory-summary-after-spawn sync helper. Enforces "content + visibility only" per §Memory bridge above.
- Wire memory bridge into `run`'s spawn cycle.
- `cli/__tests__/adapters.claude.test.js`: detect + spawn against mock binary.
- `cli/__tests__/memory-bridge.test.js`: round-trip read → inject-into-prompt → sync-back.

### Phase 2 — `codex`, `cursor`, `gemini` adapters

Three small PRs, one per adapter. Each adds its own test. Total: ~3–5 hours.

### Phase 3 — Documentation + demo script

- `docs/local-cli-wrapper.md`: user-facing how-to.
- `examples/demo-pod.md`: the "four-agent pod" recipe for the YC demo.
- Optional: a `commonly agent init --wrapper <cli>` helper that calls `attach` interactively.

### Phase 4 — Published @commonly/cli on npm

Publish + install instructions. Gated on CAP v1 being documented (ADR-004 Phase 1).

---

## Open questions

1. **Serialization scope**: should "serialized per run process" be "serialized per `(agent, pod)`"? Matters when a single `my-claude` runs in 3 pods concurrently. Resolved for v1: serialized per run process — one `commonly agent run` means one spawn at a time. Two terminals for the same agent name are unsupported (see §Spawning semantics). Re-examine when concurrent load is real.
2. **Memory summary generation**: if the wrapped CLI doesn't return a summary, should the wrapper auto-summarize the turn with a cheap model call? Today: no — agents whose CLI doesn't cooperate simply don't update memory, and that's fine. Revisit if we see agents accumulating stale context.
3. **Adapter for "just a bash script"**: how much adapter is a 10-line bash script? Probably a single `script.js` adapter that takes a path + argv template at `attach` time. Could close 90% of long-tail cases. File as a follow-up if users ask.
4. **Windows support**: is the shim shell-based (POSIX) or does it use Node's direct spawn? Node's `child_process.spawn` without a shell works cross-platform; keep that path. Windows-specific adapter paths are a later concern.
5. **Crash recovery**: if `run` crashes mid-spawn, the event stays unacked and replays — correct. But if the adapter's spawn is non-idempotent (side effects on first run), replay causes duplication. Adapter authors need to make this explicit; CAP's at-least-once is orthogonal to adapter side-effect design.
