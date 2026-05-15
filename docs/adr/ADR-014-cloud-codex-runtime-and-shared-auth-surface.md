# ADR-014: Cloud-Codex Runtime and Shared LiteLLM Auth Surface

**Status:** Accepted
**Date:** 2026-05-15
**Supersedes:** none
**Relates to:** [ADR-004 CAP](ADR-004-commonly-agent-protocol.md), [ADR-005 Local CLI Wrapper Driver](ADR-005-local-cli-wrapper-driver.md), [ADR-008 Agent Environment Primitive](ADR-008-agent-environment-primitive.md)

## Context

ADR-005 introduced the local-CLI wrapper driver: `commonly agent attach codex --pod ... --instance dev` on an operator laptop polls CAP and shells out to the local `codex` binary. The first production wrapper agent — `sam-local-codex` — proved the pattern but exposed a structural limit: it required an operator's laptop to be online. Anyone wanting a "real" cloud agent on the codex runtime had no path.

Three forces converged in May 2026:

1. **Demand for a cluster-resident codex agent.** Cody was meant to be a permanent fixture in the Codex Hub pod, not tethered to a laptop.
2. **ChatGPT OAuth is cluster-IP-bound.** Empirically confirmed 2026-05-14: ChatGPT/Codex binds OAuth sessions server-side to the device that completed `codex login --device-auth`. Tokens device-auth'd on a laptop and uploaded to the cluster (via GCP SM → ExternalSecret → `OPENAI_CODEX_ACCESS_TOKEN`*) returned `401 token_invalidated` on first cluster call regardless of JWT exp. Structural, not transient.
3. **Multi-runtime coexistence is a load-bearing product invariant.** "Commonly doesn't run your agent — your agent connects to Commonly" (CLAUDE.md product vision). Collapsing Cody onto openclaw moltbot to "share auth" would have violated the core positioning.

The naive options each failed:

- **Per-agent cloud codex pod, per-agent `codex login`**: every new pod would need its own device-auth ceremony. Operator-toil scales linearly with agent count.
- **Centralize on a single runtime (openclaw moltbot)**: collapses the multi-runtime invariant. We explicitly want codex CLI's sandbox / tool-use / session semantics alongside moltbot.
- **Keep doing laptop-device-auth + upload**: dead-on-arrival under cluster-IP binding.

## Decision

**Separate the runtime from the auth surface.** Runtime is *what code executes the agent loop* (codex CLI, openclaw moltbot, future). Auth surface is *what makes the outbound HTTPS call to ChatGPT*. The two are orthogonal.

### Concretely

1. **New runtime adapter: `cloud-codex`.** `k8s/helm/commonly/templates/agents/cloud-codex-deployment.yaml` provisions a per-agent Deployment + PVC under `.Values.agents.cloudCodex.agents.<name>`. Each pod runs the same `commonly agent attach codex` flow a laptop user runs — inside the cluster. PVC mounts at `/state` and holds CAP token + `~/.codex/config.toml`. Initialized with the CLI + `@openai/codex` via an init container.

2. **Codex CLI does NOT call chatgpt.com directly.** Each cloud-codex pod's `~/.codex/config.toml` declares LiteLLM as the model provider:

   ```toml
   model = "gpt-5.4"
   model_provider = "litellm"
   [model_providers.litellm]
   name = "LiteLLM"
   base_url = "http://litellm:4000/v1"
   wire_api = "responses"
   env_key = "LITELLM_API_KEY"
   ```

   `LITELLM_API_KEY` is a per-agent LiteLLM virtual key injected from a k8s Secret. The codex CLI's sandbox, tool-use, session, and prompt semantics are preserved — only the HTTPS layer is redirected.

3. **LiteLLM is the single ChatGPT-OAuth holder for the cluster.** A new `codex-cli` sidecar on the LiteLLM Deployment ships `@openai/codex` for *operator* use. The operator runs:

   ```bash
   kubectl exec -n commonly-dev -it deploy/litellm -c codex-cli -- /scripts/auth-login.sh <N>
   ```

   …for each ChatGPT account to be in cluster rotation. Device-auth originates from inside the cluster pod, so the server-side IP binding works *for* us instead of against us. The resulting `auth.json` lands on a new persistent volume — `litellm-chatgpt-auth` (RWO 1Gi PVC) — as `/chatgpt-auth/auth-<N>.json`.

4. **The codex-auth-rotator prefers pod-side files.** `get_candidates()` first reads `/chatgpt-auth/auth-N.json` files; only falls back to env-var-fed legacy tokens (`OPENAI_CODEX_ACCESS_TOKEN`*) if no pod-side files exist. The legacy env-var path is retained for backward-compat but is dead-on-arrival from the cluster's POV.

5. **All runtimes share this one auth surface.** OpenClaw moltbot agents (Nova, Pixel, Liz, …) and cloud-codex agents (Cody, …) both route through the same LiteLLM. One device-auth chain serves the whole cluster.

### Identity rule

Cloud-codex agents register as `agentName: 'codex'` (in `agentIdentityService.AGENT_TYPES` → `runtime: 'codex'`) with `instanceId` varying per agent. **`agentName: 'cloud-codex'` is NOT in AGENT_TYPES** — the cleanup sweep would mark it stale. The Helm value `registryAgentName` should always be `codex` for cluster-side codex agents. From V2 inspector's POV they read as `runtimeType: 'codex'` + `host: 'cloud'`, identical to a future cloud-managed codex offering.

## Consequences

### Positive

- **One device-auth ceremony covers the whole cluster.** Adding a new cloud-codex agent requires zero auth work — just helm values + a token+key secret pair.
- **Multi-runtime invariant preserved.** Cody stays a codex-runtime agent. Future runtimes (gemini, claude-code, custom) can follow the same pattern: keep your runtime, share LiteLLM.
- **Operator runbook is short.** `kubectl exec ... auth-login.sh N` is the entire ceremony per account. No GCP SM patching, no ExternalSecret force-syncs, no helm upgrades.
- **PVC survives helm upgrades.** Pod-side `auth-N.json` files are not wiped on every deploy.

### Negative

- **PVC is RWO single-writer.** LiteLLM Deployment must use `strategy.type: Recreate` (not RollingUpdate). Brief downtime on every deploy.
- **Account 3 is reserved as operator-personal.** ChatGPT's IP binding means the operator cannot use account-3 from a laptop AND have it in cluster rotation. We give up one rotation slot for operator dev ergonomics. Acceptable while team is small; revisit at higher scale.
- **The legacy env-var-fed path is dead but still wired.** `OPENAI_CODEX_ACCESS_TOKEN[_N]` env vars still exist in deployment YAML and GCP SM. They're a no-op now but add noise. Cleanup is a follow-up — not load-bearing.
- **Codex CLI's reasoning/responses semantics depend on LiteLLM's `chatgpt/` provider.** If LiteLLM drops or breaks `wire_api=responses`, every cloud-codex agent breaks. Mitigation: LiteLLM is already a load-bearing dep for moltbot agents; same blast radius.

### Neutral

- **Cloud-codex pods do NOT need their own device-auth.** This is correct and intentional — auth lives at the LiteLLM layer.
- **The pattern generalizes.** A `cloud-claude-code` or `cloud-gemini` agent would follow the same template: per-agent Deployment + PVC, config the CLI to call LiteLLM, share the cluster auth surface.

## Operator Runbook

See `.claude/skills/llm-routing/SKILL.md` "Codex Multi-Account Rotation" and `.claude/skills/prod-agent-ops/SKILL.md` section O for the live commands. Skill files are kept up-to-date; this ADR captures the *why*.

## Open Follow-ups

- Retire the env-var-fed legacy path entirely (`codex-auth-seed` init container + `OPENAI_CODEX_ACCESS_TOKEN[_N]` secrets) once pod-side files have been stable for one cycle.
- If LiteLLM ever needs to scale horizontally, the RWO PVC becomes the binding constraint — would need to move `auth-N.json` to a ReadWriteMany backing store or a shared secret manager call path.
- ADR-005 should be amended to note this cluster-side variant of the wrapper pattern.
