# Bring-your-own-key design (D81)

**Status:** proposed 2026-10-27
**Owner:** wisp (design). Tier 2 (keys and money): Opus code gate on every implementation PR; ux-lead gates the UI section (write-only key entry, team scope).
**Ledger:** D81 (10-25, Sam), un-parked 10-27 ~12:00 PT by the Cofounder.

Line references are to `origin/main` at `9823d2bb`. Every claim about current code cites a file and line range. Anything marked **to verify** is a design assumption with no spike yet.

## Current state (what exists today)

- **One key setter, one harness, one sandbox.** `ownKeyCapability` only offers the own-key setter for `runtimeType === 'wrapper'` with `harness === 'opencode'`, `sandbox.trust` public, a confined mode (`workspace`, `read-only` or `bwrap`) and an https destination (`backend/services/agentProviderKey.ts:13-24`). The comment there records Lily's confined-modes ruling: the other harnesses expose their bearer to tool env and config, so they get no setter.
- **Metadata-only reads.** `GET /agents/:name/provider-key` returns `{set, setAt, setBy, lastUsedAt}` and nothing else, with `Cache-Control: no-store` (`agentProviderKey.ts:43-53`, `metadata()` at `:30-31`). The write path is `PUT` with `{key}` and validation at `:65-68`, and `DELETE` at `:52-63`.
- **Per-generation immutable secrets.** Each set writes a new `ConnectorSecret` (`connectorSecrets.ts:164-171`, `put`), bumps `generation`, and revokes the previous ref only after the row commits (`agentProviderKey.ts:69-82`). The ref is the only thing on `AgentProviderKey` (`backend/models/AgentProviderKey.ts:4-11`), keyed by `agentUserId` with a unique index.
- **The key does leave the server, to the daemon.** `launchProviderKey` returns the decrypted key to an authenticated machine daemon (`agentProviderKey.ts:97-125`; route at `backend/routes/agentsRuntime.ts:525-527`). That is the opencode BYO path. It is not a model-layer path and must not become one (see §1).
- **Hosted agents use our key, through LiteLLM.** The provisioner issues per-agent LiteLLM virtual keys and stores them on the agent's PVC (`backend/services/agentProvisionerServiceK8s.ts:1576` read, `:1599` `issueLiteLLMVirtualKey`, `:1676` `issueLiteLLMOpenRouterKey`, `:1753` injection into auth profiles). So an agent process **already holds a gateway bearer**, though not a vendor key. The vendor key stays at the gateway.
- **Native calls disable fallbacks.** The native runtime sends `disable_fallbacks: true` (`backend/services/nativeRuntimeService.ts:2092`). The LiteLLM config has no fallback to another model or vendor for the hosted DeepSeek default, and a test pins that (`backend/__tests__/unit/helm/litellmHostedFallback.test.js:8-30`, which also asserts Workers AI is not a route or fallback target).
- **Run ceiling is per user.** `userRunCeilingForOwner` returns 120 for free and 300 for pro, from env (`backend/services/hostedRuntimeService.ts:83-89`), and applies to the owner (`backend/routes/registry/manage-settings.ts:111`).
- **Spend is tokens, not money.** `AgentRun` records prompt, completion and total tokens and a `liteLLMCallId` (`backend/models/AgentRun.ts:61-67`, `:135-136`). The header says there are "no cost/budget fields" (`:11`). `servedModel` and `fallbacks` come from LiteLLM headers (`backend/services/nativeRuntimeService.ts:1436-1452`, `AgentRun.ts:70-72`).
- **Stale copy.** The public legal page still says "Cloudflare Workers AI is the fallback" (`frontend/src/v2/legal/V2LegalPage.tsx:54`). That contradicts D81(a) and the removal in #2718, which is in prod. It is a copy fix, out of scope for this note, and listed in §7.

## Constraints that bind the design

1. **Confined-modes ruling (Lily):** a harness's own credential path exposes its bearer to tool env and config. A key must never reach an agent process or tool env. (`agentProviderKey.ts:15-17`.)
2. **No brokering of Claude usage (Stack L6, Anthropic's Claude Code terms, Cofounder ruling B, 10-25):** we never pay for, resell or intermediate a user's Claude subscription, and we never hold a subscription or session token. Hosted agents reach Claude only through the model API, with the user's own Anthropic API key or ours.
3. **Our key is the default, not the fallback.** A failed or exhausted user key fails the turn visibly. It never falls back onto our key (D81(a)).

## 1. Model-layer keys, per user and per team, routed per request

**Recommendation:** the vendor key is registered at the gateway and never leaves it. The agent keeps only its own gateway bearer, as it does today.

- Store the vendor key the way `AGENT_PROVIDER_KEY` already stores material: an encrypted `ConnectorSecret` with a generation and a revoke-after-commit (`connectorSecrets.ts:164-183`, `connectorSecretKinds.ts:111-113`). Add a new kind, e.g. `MODEL_PROVIDER_KEY`, so the audit and rewrap paths stay separate.
- At call time, the gateway resolves the caller's virtual key to its owner and team, then selects the owner's or team's vendor key for that one request. The mechanism is **to verify**: LiteLLM team- or key-scoped model deployments are the likely route. A spike must show that a request carrying team A's virtual key cannot resolve team B's deployment, and that the key string never appears in the response, the logs or the agent's env.
- Do **not** extend `launchProviderKey` (`agentsRuntime.ts:525`) to model-layer keys. That path hands the plaintext to a daemon. The model layer needs the key to stay in the gateway's process.

## 2. Harness layer: a person's own subscription

**Recommendation: out of scope for hosted agents. Ruled out explicitly.**

- Hosted agents cannot hold a subscription or session token (constraint 2).
- BYO CLI seats already run the person's own Claude Code or Codex binary, signed in on their own machine. No grant is needed, and we hold nothing.
- The only harness-layer key path that exists (opencode, `agentProviderKey.ts:13-24`) passes a **vendor API key**, not a subscription. Extending it to another harness re-opens the confined-modes problem. Keep it confined to `public` plus a confined mode, as today.

**Decision for Sam/Lily:** confirm that "harness layer = out of scope for hosted; BYO CLI stays as today" closes D81(2). If Sam wants a per-run harness grant for API keys in a confined sandbox, that is a separate design, and it is the only way the harness layer returns.

## 3. Write-only UI

- The contract already exists. The UI sends `PUT {key}` and reads only metadata (`frontend/src/v2/components/V2AgentProviderKey.tsx:28`, `:45` a `type="password"` input with `autoComplete="new-password"`). Nothing reads the key back.
- Keep that invariant for every new surface: no route returns key material to a browser, no "show key" control, and `no-store` on every key response (`agentProviderKey.ts:44`).
- New surfaces: a personal key in account settings, and a team key in the team admin view. Both show `set`, `setAt`, `setBy` and last-used only. Replacing a key is a new PUT, not an edit.
- **ux-lead gates this section.**

## 4. Spend attribution and caps

- **Attribution:** every BYO call already has a `liteLLMCallId` (`AgentRun.ts:67`). Attribute spend by joining that to the gateway's spend log per key, not by parsing our token counts. Token counts in `AgentRun` are not money, and there is no cost field to fill (`:11`).
- **Caps:** a per-key budget set at the gateway (LiteLLM's key or team budget, **to verify**). The budget is enforced by the vendor-side path, so a runaway agent cannot exceed it.
- **Run ceiling: recommendation.** A team key does **not** change the run ceiling. Runs still count against the invoking user's ceiling (`hostedRuntimeService.ts:83-89`, `manage-settings.ts:111`). The ceiling protects our abuse surface; the key cap protects the money. Two separate limits.
- **Team key cap:** a team key carries its own cap, set by a team admin. It does not draw from any member's personal cap.

## 5. Failure is visible, with no fallback onto our key

- A BYO turn sets `disable_fallbacks: true` as native calls do today (`nativeRuntimeService.ts:2092`). The BYO deployment is bound only to the user's key, so the router has no chain that reaches our default.
- Map gateway errors to named turn errors: `auth_failed`, `rate_limited`, `budget_exceeded`, `key_unavailable`. The turn ends with that code shown in the pod. It does not retry on our key.
- Test (new): a BYO turn with a revoked key returns the named error, `AgentRun.fallbacks` is 0 (`AgentRun.ts:70-72`), and `servedModel` equals the requested model.

## 6. How it extends `agentProviderKey.ts`

Today the setter is keyed by **seat** (`AgentProviderKey.agentUserId`, unique) and gated by `ownKeyCapability` (`agentProviderKey.ts:13-24`). Extend it in four steps:

1. **Scope.** Change the row from `agentUserId` to `scope: {kind: 'user' | 'team', id}`, keeping the seat row for the existing opencode path. Migrate existing rows to `kind: 'user'` with the seat as a sub-key. The unique index moves with it.
2. **Capability.** Keep `ownKeyCapability` for the opencode harness. Add a second capability for the model layer, which requires only an https provider, the gateway being reachable, and an owner or team role check. It does **not** depend on the harness, the sandbox trust or `runtimeType`, because the key never reaches the agent.
3. **Resolution.** Do not reuse `launchProviderKey` for the model layer. Add a gateway-side resolver that the LiteLLM router calls, and keep `launchProviderKey` for opencode only.
4. **Generations and revocation.** Keep the immutable per-generation secret and revoke-after-commit pattern (`agentProviderKey.ts:69-82`). Keep the 409 on a changed destination.

## 7. PR-by-PR estimate

My estimate, one owner, not yet reviewed by CTO:

| PR | Scope | Size | Gate |
|---|---|---|---|
| 0 | Spike: LiteLLM team/key-scoped deployment routing, key-not-in-response proof, budget field behaviour | S (2–3 days) | Opus |
| 1 | Schema: `scope` on `AgentProviderKey`, migration of seat rows, index change | S | Opus |
| 2 | Gateway resolver and per-request routing for user keys | M | Opus |
| 3 | Named turn errors, `disable_fallbacks` on BYO turns, `fallbacks === 0` test | S | Opus |
| 4 | Spend attribution: `liteLLMCallId` joined to gateway spend log; per-key budget | M | Opus |
| 5 | Write-only personal key UI | S | Opus + ux-lead |
| 6 | Team key: admin role, team cap, team UI | M | Opus + ux-lead |
| 7 | Copy: drop Cloudflare from `V2LegalPage.tsx:54`, add a BYO section to the legal and privacy pages | XS | ux-lead |

Total: about 7 PRs, roughly 3–4 weeks for one owner, with PR 0 deciding whether PRs 2 and 4 keep their shape. PR 7 is copy-only and does not need the prod freeze lifted, so it can go before launch if Growth wants it.

## Open questions

- **Harness layer (§2):** Sam or Lily to confirm "out of scope for hosted" closes D81(2).
- **Team cap semantics (§4):** a team key carries its own cap, separate from member run ceilings. Confirm.
- **Spike result (§1, §4):** if LiteLLM cannot scope deployments per key, PR 2 changes shape. This note would then go back to review.
