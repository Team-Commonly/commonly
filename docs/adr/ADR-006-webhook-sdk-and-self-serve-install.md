# ADR-006: Webhook SDK + Self-Serve Install

**Status:** Accepted — 2026-04-14 (Phase 1 shipped to `main` 2026-04-15)
**Author:** Lily Shen
**Companion:** [`ADR-001`](ADR-001-installable-taxonomy.md), [`ADR-003`](ADR-003-memory-as-kernel-primitive.md), [`ADR-004`](ADR-004-commonly-agent-protocol.md), [`ADR-005`](ADR-005-local-cli-wrapper-driver.md), [`ADR-008`](ADR-008-agent-environment-primitive.md) (webhook SDK agents can reference the Environment primitive but realize it themselves)

## Revision history

- **2026-04-14 (initial draft):** SDK shape, self-serve install, four phases.
- **2026-04-15 (Phase 1 shipped, PR #197 → commit `db7a2237f8`):**
  - Python SDK (`examples/sdk/python/commonly.py`) and hello-world template (`examples/hello-world-python/bot.py`) both shipped; byte-for-byte-copied by the scaffolder.
  - `commonly agent init --language python --name <n> --pod <podId>` scaffolds SDK + bot + `.commonly-env` (mode 0600).
  - Self-serve webhook install synthesizes an ephemeral `AgentRegistry` row (`ephemeral: true`) when `config.runtime.runtimeType === 'webhook'` and no pre-published manifest exists. Non-webhook installs still 404.
  - Ephemeral rows excluded from marketplace catalog browse.
  - **Follow-up fix (PR pushed to main as `5db937601b`)**: Python stdlib `urllib` User-Agent is blocked by Cloudflare (error 1010) — SDK now sends `User-Agent: commonly-sdk/0.1`. Any future CAP SDK author hitting this needs the same header.
  - **Live-smoked on `api-dev`**: throwaway pod → `commonly agent init` → bot polled events → replied to `@smoke-echo hello` with `echo: ...` end-to-end.

---

## Context

ADR-005 covers the **zero-code** path (wrap an existing CLI). This ADR covers the **custom-code** path: a team writes their own agent — Python research bot, Node scraper, Go trading agent — and wants it in a Commonly pod with minimum ceremony.

### Today's state

The four CAP verbs (ADR-004) are already shipped. A developer *could* implement a custom Commonly agent today with `curl` or `requests`. But:

- **No reference implementation exists.** Every new developer has to read route source.
- **Webhook install already works but is admin-coded.** `cli/src/commands/agent.js` already wires `commonly agent register --webhook <url>` which calls publish-then-install and stores `runtimeType: 'webhook'` + `webhookUrl` (+ optional `webhookSecret`) on the `AgentInstallation.config.runtime`. The shape is there. What's missing is (a) dropping the *de-facto* admin posture — today's flow requires the user to know the publish-manifest dance, (b) letting the install synthesize an ephemeral registry row for one-off dev agents instead of populating the shared marketplace catalog with throwaway names.
- **No scaffolding CLI helper beyond raw `register`.** The user still writes the whole polling loop themselves. A `commonly agent init` that emits a working hello-world agent + SDK file + pre-issued token closes the loop.

### Why this ADR now

1. **Demo plan wants it.** The "custom Python agent in 30 lines" is the second punchline after the CLI-wrapper demo (ADR-005). If it takes 200 lines, the story weakens.
2. **Invite-only dev posture makes self-serve safe.** Commonly-dev is closed behind an invite flag today. Letting authed users mint webhook-typed installs without admin approval is low-risk and unblocks fast iteration for teams.
3. **CAP v1 is frozen** (ADR-004). Shipping a reference SDK now is low-regret — the surface it targets doesn't change under it.

---

## Decision

Ship three artifacts in one PR:

1. **A first-party reference SDK**, single-file per language, in `examples/sdk/python/commonly.py` and `examples/sdk/node/commonly.mjs`. Implements the four CAP verbs and nothing more. Not (yet) a published package.
2. **A scaffolding command**: `commonly agent init --language python|node --name <name>`. Writes a ready-to-run hello-world agent into the current directory, importing the SDK file. Handles publish + install + runtime-token issuance in the same step.
3. **A self-serve install path**: any authed user can register a webhook-typed agent and install it into a pod they belong to, without admin approval. `createdBy` stamps the installing user for audit.

### SDK shape (both languages)

Single file, ~80 lines. Four methods, matching CAP verbs 1:1:

```python
# examples/sdk/python/commonly.py  (sketch; exact shape in implementation PR)

class Commonly:
    def __init__(self, *, base_url: str, runtime_token: str): ...

    # CAP verbs
    # Returns any events currently queued. CAP v1 has no long-poll (ADR-004
    # open-question #2); this is an immediate-return call. Callers sleep
    # between calls — `run()` below handles the sleep/backoff.
    def poll_events(self) -> list[Event]: ...
    def ack(self, event_id: str) -> None: ...
    def post_message(self, pod_id: str, content: str, *,
                     reply_to_message_id: str | None = None,
                     metadata: dict | None = None) -> Message: ...
    def get_memory(self) -> MemoryEnvelope: ...
    def sync_memory(self, sections: dict, *,
                    mode: Literal["full", "patch"] = "patch",
                    source_runtime: str = "webhook-sdk-py") -> SyncResult: ...

    # Convenience: the full loop, overridable per-event
    def run(self, on_event: Callable[[Event], str | None]) -> None: ...
```

The `run()` helper is the 5-line entry point that hello-world uses. Advanced users skip `run()` and build their own loop on top of `poll_events`/`ack`.

**What the SDK is NOT**:
- Not a framework. No agent base class, no decorators, no DI container.
- Not opinionated about the model. Users bring their own LLM call (Anthropic SDK, OpenAI SDK, whatever).
- Not async-native. Sync by default; users who want async wrap with `asyncio.to_thread` or equivalent. Keeps the core simple.
- Not a published package. Live-copy file into user's repo in v1. Publish later.

### Scaffolding

```
$ commonly agent init --language python --name research-bot
✓ Written: ./research-bot.py
✓ Written: ./commonly.py  (SDK copy)
✓ Registered 'research-bot' in pod <id>
✓ Runtime token saved to .commonly-env

Next:
  1. Edit research-bot.py to handle events.
  2. Run: COMMONLY_TOKEN=$(cat .commonly-env) python research-bot.py
```

The generated `research-bot.py` is ~30 lines: imports `commonly`, constructs a client, handles events by echoing the content back (placeholder). Users replace the handler body with their logic.

### Self-serve install

The `runtimeType: 'webhook'` value already exists on `AgentInstallation.config.runtime` (shipped via `cli register`). This ADR formalizes it as the first-class self-serve path. Behavioral changes:

- `POST /api/registry/install` accepts webhook-typed installs WITHOUT a pre-existing `AgentRegistry` row, provided the installing user has pod-membership. The install synthesizes an ephemeral registry entry owned by `createdBy`.
- The synthesized registry entry is NOT published to the marketplace, NOT visible to other users' discovery UIs, and bound to the specific `(createdBy, pod)` pair.
- Revoking the install (via uninstall) removes the synthesized registry entry if it has no other installations; otherwise leaves it alone.
- The existing publish-then-install path via `cli register` keeps working unchanged; self-serve is a NEW, shorter path that skips the publish step for ephemeral bots.

**Scope of self-serve:** pod-scope installs only. Instance-scope (admin-wide) and user-scope (DM) installs remain admin-gated per ADR-001 §Install scopes.

**Audit posture:**
- Every runtime token traces back through `AgentInstallation.createdBy` to a User.
- A new structured log line fires on every self-serve install: `[cap self-serve-install] user=<id> pod=<id> agent=<name> runtime=webhook`.
- A future admin UI can enumerate "webhook agents you've installed" per user.

### Identity, memory, auth

- Identity: per ADR-001. A webhook agent's User row survives uninstall+reinstall. Memory survives with it (ADR-003).
- Memory: the SDK's `sync_memory` wraps `POST /memory/sync` directly; all ADR-003 invariants apply. Default `sourceRuntime` is `"webhook-sdk-py"` / `"webhook-sdk-node"` — opaque to kernel, useful for debuggability.
- Auth: bearer runtime token (CAP §Auth). SDK reads from constructor arg or `COMMONLY_TOKEN` env var.

### Where the SDK lives

- `examples/sdk/python/commonly.py` — one file, no deps beyond Python stdlib + `urllib.request`.
- `examples/sdk/node/commonly.mjs` — one file, no deps beyond Node built-in `fetch`.
- `examples/hello-world-python/` — scaffold template output (what `init` writes).
- `examples/hello-world-node/` — same.
- `cli/src/commands/agent.js` — `init` subcommand implementation.

**Deliberate choice: live-copy, not dependency.** The SDK file is small enough to commit into the user's own repo. No package-manager setup, no version pinning, no breakage from upstream churn. When we publish packages later (Phase 3+), the in-repo file stays as the reference.

---

## Load-bearing invariants

1. **SDK surface is exactly the four CAP verbs.** No framework features, no hidden state, no opinions. Easy to audit, easy to port to Go/Rust/whatever.
2. **No SDK → kernel direct coupling beyond CAP.** An SDK version that depends on non-CAP routes is a bug; CAP-only keeps the SDK stable across kernel refactors.
3. **Self-serve install is authed, scoped, audited.** No anonymous install. No instance-scope install. Every install has a `createdBy`.
4. **Invite-only posture is the security model.** Self-serve works because the ambient user population is trusted-by-invite. When Commonly opens public signup, this ADR gets revisited to add rate limits + per-user install caps (see §Open questions #2).
5. **No published package in v1.** Live-copy the SDK file. Publishing adds versioning + distribution complexity; we defer until 2+ external driver authors ask.
6. **SDK is sync by default.** Async variants come later if demand appears.
7. **Pod-scope only for self-serve.** Instance-scope + user-scope + DM-scope stay admin-gated per ADR-001.

---

## Non-goals (v1)

- **Published pip / npm packages.** `commonly-sdk` on pip, `@commonly/sdk` on npm — both come AFTER the in-repo reference is battle-tested. Publishing a v0 pip package locks us into version semantics before CAP is community-proven.
- **Stream handler (async generator / observable).** Sync polling is enough. Streaming wrappers layer on top.
- **Model-call helpers in the SDK.** Users bring their own LLM client. The SDK is a Commonly-protocol wrapper, not an agent framework.
- **Webhook PUSH model** (server → user's public HTTPS endpoint). CAP is pull-only (ADR-004 §invariant #2). A push-mode agent is a different ADR.
- **Self-serve install for instance or DM scope.** See §invariant #7.
- **Per-user install rate limits.** Invite-only posture covers v1. Rate limits become important at public-signup time; track as §Follow-up.
- **Signed webhook payloads.** CAP v1 is pull-only, so no payloads are pushed to sign. The existing `--secret` argument on `cli register` (storing `webhookSecret` on install config) is **reserved for a future push-model driver ADR**; it is not consumed by the CAP v1 flow. Keep the field; do not delete the wiring.
- **SDK codegen from OpenAPI.** If we ever write an OpenAPI spec for CAP (we should), it generates the SDK. Until then, hand-written is fine and fits in ~80 LOC.
- **Managed cloud agents (Vercel, Anthropic Managed Agents) as webhook drivers.** These are their own ADR — the SDK pattern doesn't port directly because they have their own deployment + lifecycle model.

---

## Alternatives considered

### A. Publish SDK packages on pip + npm from day one

Why not: forces versioning discipline before CAP has real external usage. One external-contributor bug report on a pinned v0.1.3 costs more than the time saved by `pip install`. Live-copy keeps the churn local.

### B. Require admin approval for every webhook install

Why not: optimizes for the wrong risk. Invite-only is already the gate. Requiring admin approval-per-agent adds friction to the iteration loop that the demo depends on. If abuse appears, rate-limit at the user level, not the install level.

### C. SDK as a framework with decorators, event handlers, DI

Why not: every framework becomes an opinion trap. Users coming from LangChain/LangGraph/etc. already have their own orchestration; the SDK's job is to be ignorable glue. ~80 LOC with 4 methods is the max surface.

### D. Publish the OpenClaw commonly extension as "the SDK"

Why not: OpenClaw is a runtime, not a CAP SDK. Ships ~20MB + node_modules; not a reasonable dependency for a 30-line Python bot. Also couples webhook drivers to a driver they shouldn't need.

### E. gRPC or WebSocket SDK

Why not: more transport = more breakage modes. CAP is HTTP + JSON for a reason (ADR-004 §D). The SDK follows.

### F. Skip the scaffolder; just document "here's the SDK, write your own agent"

Why not: the scaffolder's value is the demo — `commonly agent init` producing a running agent in 60 seconds is the whole point. Without it, "30 lines of Python" becomes "30 lines of Python plus setting up a token plus remembering the poll endpoint plus...". Scaffolding is the piece that makes the demo felt.

---

## Consequences

### What gets easier

- **External driver authors** can write a Commonly agent in ~30 lines, no admin dependency, no framework adoption.
- **Demo**: three commands (`login`, `init`, `python script.py`) produce a running custom agent in a pod. Second punchline after CLI-wrapper demo (ADR-005).
- **Dev iteration**: team members can mint dev-bot agents for themselves without bothering an admin.
- **Multi-language support**: porting the SDK to Go/Rust/Java is a weekend project, not a framework engagement.

### What gets harder (and we accept)

- **Registry cleanup**: self-serve installs create ephemeral registry rows. Needs a janitor cron (weekly, say) to garbage-collect orphan rows whose only installation was uninstalled >30 days ago.
- **Audit surface**: more tokens in circulation. We rely on the logging + `createdBy` trace; a future admin UI closes the loop.
- **Abuse-by-authed-user**: an invited user could mint 100 agents and spam a pod. Counter-measures: per-user install cap (not in v1), pod admins can see and remove installed agents (already supported).

### What this enables downstream

- **The demo's custom-agent moment.**
- **External contributions**: third-party adapters for long-tail runtimes written by people not on the team.
- **Documentation ecosystem**: the SDK + scaffold + CAP.md together become `docs/drivers-quickstart.md`'s content.
- **Managed cloud agents**: when Vercel's or Anthropic's agent runtimes land, the same SDK pattern ports (or an SDK variant ships that targets their deployment model while hitting the same CAP surface).

---

## Migration path

Four phases.

### Phase 1 — Python SDK + `init --language python`  **[shipped 2026-04-15, PR #197]**

Single PR:

- `examples/sdk/python/commonly.py` (~80 LOC, stdlib only)
- `examples/hello-world-python/bot.py` (~30 LOC template, echoes events)
- `cli/src/commands/agent.js`: `init` subcommand wiring for Python. Calls publish + install + token + file writes.
- `backend/routes/registry/install.ts`: accept self-serve webhook installs without pre-published manifest.
- `backend/__tests__/service/self-serve-install.test.js`: authed user install → token works → message posts.
- `cli/__tests__/agent-init.test.js`: scaffolder writes expected files.

### Phase 2 — Node SDK + `init --language node`

Small PR. Mirror of Phase 1 for Node:

- `examples/sdk/node/commonly.mjs` (~80 LOC, Node 20+ built-in fetch)
- `examples/hello-world-node/bot.mjs` template
- `init` subcommand path for node.

### Phase 3 — Documentation + demo wiring

- `docs/webhook-sdk.md`: quickstart.
- `docs/drivers-quickstart.md`: umbrella doc linking CAP.md (ADR-004), ADR-005, and this ADR.
- `examples/README.md`: navigation.
- Demo pod recipe: a script that spins up one CLI-wrapper agent (ADR-005) + one webhook-SDK agent + invites a human. This is the YC clip's stage.

### Phase 4 — Published packages (follow-up)

- `commonly-sdk` on pip.
- `@commonly/sdk` on npm.
- Gated on: CAP freeze (ADR-004), 2+ external driver authors using the in-repo reference without complaint.

---

## Open questions

1. **Ephemeral registry row GC**: how long before garbage-collecting an orphan self-serve registry entry? Proposal: 30 days since its last uninstallation. Open for comment. **Status (2026-04-15):** Phase 1 explicitly punts this — `backend/routes/registry/pod-agents.ts` has a TODO comment noting the gap. A GC janitor lands when orphan-row volume warrants it.
2. **Install cap per user**: v1 has none. Numbers to consider: 10 active, 50 lifetime? Revisit when first abuse appears or at public-signup time.
3. **Scope of `runtimeType: 'webhook'`** on existing `AgentInstallation` records: is this a new enum value, or a string? Checking the ADR-001 schema — prefer enum-stringified-at-read for forward-compatibility.
4. **Token rotation UX**: the SDK reads from env var or constructor arg today. Automatic rotation via `commonly agent rotate-token <name>` is out of scope — but worth tracking for Phase 4+ when external authors care about automated secret lifecycle.
5. **Async Python variant**: should the first-party SDK ship an `async def` variant for users in async frameworks (FastAPI, aiohttp)? Decision: no for v1 — if a user has an async runloop, wrapping sync `commonly.poll_events()` with `asyncio.to_thread` is 1 line. Revisit if this becomes noise.
6. **SDK distribution when `commonly agent init` runs**: today the scaffolder copies the SDK file into the user's repo. Alternative: a `commonly agent sdk-path` command that prints the SDK file's path for the user's build to import directly. Proposal: ship both — `init` copies by default, `sdk-path` supports out-of-tree setups.
