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
- **Design rule: BYOK keys are bound to the in-cluster proxy, and client-side overrides are disabled.** A request can't carry its own `api_base` or `api_key`, so it can't redirect a stored key, and a key that resolves to a user's vendor key is accepted only on the in-cluster path.
- **The agent's gateway bearer is bounded.** The per-agent virtual key stays in the agent's environment, and the agent's tools can read it. So any virtual key that can resolve to a user's vendor key gets its own model allowlist, budget and rate limit, and is rotated on reprovision. The vendor key is never exposed. The bearer that spends it is exposed, which is why it must be bounded.
- LiteLLM's credential routing selects credentials by team and project, not by user. A personal key maps to a one-member team and an agent key to a project. That mapping is **to verify** in the spike.

## 1a. Scopes and which key a turn uses

There are three scopes, plus our default:

| Scope | Set by | Serves | Precedence |
|---|---|---|---|
| Agent | the agent's owner | one hosted agent | 1 |
| Team | a team admin | hosted agents run in that team's pods | 2 |
| User | the person | hosted agents that person owns | 3 |
| Ours | — | everything else (the default, never a fallback) | 4 |

The source is resolved once, at turn start. It is recorded on `AgentRun` as `keySource: ours | user | team | agent` and never changes mid-turn. Open: whether team should beat user (as here) or user beat team, and whether "team" means the workspace rather than the pod.

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

- **Attribution:** `IAgentRunTurn.liteLLMCallId` is optional today (`AgentRun.ts:67`), so not every call is guaranteed to carry it. For BYO turns it becomes required: every metered BYO call, including a failed call that was still charged, records the gateway's call id. A BYO call with no id is counted as unattributed in the spend report, never dropped. The gateway spend log is reconciled against `AgentRun` daily. Attribute spend by joining the call id to the gateway's spend log per key, not by parsing our token counts. Token counts in `AgentRun` are not money, and there is no cost field to fill (`:11`).
- **Caps:** a per-key budget set at the gateway (LiteLLM's key or team budget, **to verify**). The gateway enforces the budget, so a runaway agent cannot exceed it.
- **Run ceiling: recommendation.** A team key does **not** change the run ceiling. Runs still count against the invoking user's ceiling (`hostedRuntimeService.ts:83-89`, `manage-settings.ts:111`). The ceiling protects our abuse surface; the key cap protects the money. Two separate limits.
- **Team key cap:** a team key carries its own cap, set by a team admin. It does not draw from any member's personal cap.
- **Metering split.** A BYOK turn removes our inference cost, not our compute cost. It still counts toward the run ceiling and any agent-hour meter, but not toward anything that meters our inference spend. `AgentRun.keySource` makes that split computable.
- **Plans (proposed).** Personal and agent keys on Free and Pro. Team keys on Pro, because they need admin roles and a team cap. No markup on inference that runs on a user's key.
- **Labels.** A run on someone's key shows "on your key" or "on the team key". Settings show last use, month-to-date spend from the gateway, and the cap, never the key.

## 5. Failure is visible, with no fallback onto our key

- A BYO turn sets `disable_fallbacks: true` as native calls do today (`nativeRuntimeService.ts:2092`). The BYO deployment is bound only to the user's key, so the router has no chain that reaches our default.
- Map gateway errors to named turn errors: `auth_failed`, `rate_limited`, `budget_exceeded`, `key_unavailable`. The turn ends with that code shown in the pod. It does not retry on our key.
- Test (new): a BYO turn with a revoked key returns the named error, `AgentRun.fallbacks` is 0 (`AgentRun.ts:70-72`), and `servedModel` equals the requested model.

## 6. How it extends `agentProviderKey.ts`

Today the setter is keyed by **seat** (`AgentProviderKey.agentUserId`, required and unique, `backend/models/AgentProviderKey.ts:3`) and gated by `ownKeyCapability` (`agentProviderKey.ts:13-24`). Extend it in five steps:

1. **Scope.** Add `scope: {kind: 'user' | 'team' | 'agent', id}` to `AgentProviderKey`. Existing rows are backfilled as `kind: 'agent'`, `id: agentUserId`. They are seat keys, one per agent, set through the opencode harness. Read as `user` scope, one seat's key would resolve for every agent its owner has. `agentUserId` becomes optional, because a user or team row has no seat. Its non-partial unique index is replaced by a partial unique index on `agentUserId` where `scope.kind` is `agent`, and a unique index on `(scope.kind, scope.id)` covers user and team rows. `launchProviderKey` looks rows up by `agentUserId` and `ownerUserId`, so it keeps finding only agent rows and works unchanged. `agentUserId` is retired only after `launchProviderKey` reads `scope`, in its own PR with a rollback path.
2. **Model-layer keys get their own collection.** They do not share `AgentProviderKey`. A separate `ModelProviderKey` model means `launchProviderKey` cannot reach a model-layer row by construction. The shared-collection alternative needs a `layer` field and a pin on the daemon lookup. We reject it: one missed filter would send a plaintext model key to a daemon, which §1 says must never happen.
3. **Capability.** Keep `ownKeyCapability` for the opencode harness. Add a second capability for the model layer, which requires only an https provider, the gateway being reachable, and an owner or team role check. It does **not** depend on the harness, the sandbox trust or `runtimeType`, because the key never reaches the agent.
4. **Resolution.** Do not reuse `launchProviderKey` for the model layer. Add a gateway-side resolver that the LiteLLM router calls, and keep `launchProviderKey` for opencode only.
5. **Generations and revocation.** Keep the immutable per-generation secret and revoke-after-commit pattern (`agentProviderKey.ts:69-82`), in both collections. Keep the 409 on a changed destination.

## 7. PR-by-PR estimate

My estimate, one owner, not yet reviewed by CTO:

| PR | Scope | Size | Gate | Done when |
|---|---|---|---|---|
| 0 | Spike: LiteLLM credential routing as the isolation boundary | S | Opus, security | Team A's virtual key never resolves team B's credential. A client-side `api_base` or `api_key` is refused for an agent key, and the stored key is never sent to that base. The key appears in no response or log. A one-member team and a project carry the user and agent scopes. Results are posted on the row. |
| 1 | Schema: additive `scope` on `AgentProviderKey`, existing rows backfilled as `kind: 'agent'`, `agentUserId` made optional, partial and scope indexes; the separate `ModelProviderKey` model | S | Opus | Before and after the backfill, an existing opencode key still resolves through `launchProviderKey` (test). A user-scoped row and a team-scoped row can be created beside an existing agent row (test). The unique indexes hold per scope. `agentUserId` is not removed in this PR. |
| 2 | Key-source resolution and the per-request gateway resolver | M | Opus | Unit tests cover each precedence pair. The source never changes mid-turn. `AgentRun.keySource` is written. |
| 3 | Bound the agent's gateway bearer | S | Opus, security | A BYOK-resolving virtual key gets 403 for a model off its allowlist, `budget_exceeded` when its budget is spent, and is refused outside the in-cluster path. Reprovision invalidates the old key. |
| 4 | Named turn errors, `disable_fallbacks` on BYO turns | S | Opus | A revoked key ends the turn with `auth_failed`, `AgentRun.fallbacks === 0`, and `keySource` unchanged. |
| 5 | Spend attribution and the metering split | M | Opus | A service test with mixed turns gives correct run-ceiling, agent-hour and inference totals per `keySource`. Every metered BYO call, including a charged failure, records a `liteLLMCallId`. A call missing one appears as unattributed, not omitted. |
| 6 | Write-only key UI for personal, agent and team keys, plus plan gating | M | Opus + ux-lead | Entitlement tests show Free can't set a team key. No route returns key material. Screenshots at 390 and 1440 of each scope and of the "on your key" label. zh-CN pass. |
| 7 | Copy: drop the Cloudflare line from `V2LegalPage.tsx:54`; add a BYOK section to the legal and privacy pages | XS | ux-lead | Every claim on the pages is backed by PRs 0–6 as each lands. |

Total: about 8 PRs, roughly 3–4 weeks for one owner, with PR 0 deciding whether PRs 2 and 4 keep their shape. PR 7 is copy-only and does not need the prod freeze lifted. Move it to the front: the Cloudflare line is live on the public legal page today, and #2718 removed that fallback on 10-25 (Rhea's gate).

## Open questions

- **Scope precedence (§1a):** whether team beats user or user beats team, and whether "team" means the pod or the workspace.
- **Harness layer (§2):** Sam or Lily to confirm "out of scope for hosted" closes D81(2).
- **Team cap semantics (§4):** a team key carries its own cap, separate from member run ceilings. Confirm.
- **Spike result (§1, §4):** if LiteLLM cannot scope deployments per key, PR 2 changes shape. This note would then go back to review.
