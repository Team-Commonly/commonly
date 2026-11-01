# TASK-442: one routing decision per non-rule message

Status: two-candidate study recorded, 2026-10-24. DeepSeek failed the tested
configuration; Nano was unavailable. Decision: retain rules-only routing. No model is
selected and no production integration is included.

## Contract

Explicit mentions, owned rows/TASK/PR references and live claimed-thread rules
remain authoritative and do not call a model. If any rule addresses a seat,
route those wakes and deliver other eligible recipients their normal digest.
Only a message with no rule match is eligible for classification. Rule lookup
failure is uncertainty, so retain digest and skip the model rather than asking
it to reconstruct missing authorization evidence.

The per-pod flag starts disabled. Disabled means today's rules and receipt
policy, with no extra calls. Enabling it explicitly selects model routing for
non-rule ambient activity; it must not change explicit addressing or DM routing.
The classifier never assigns/reassigns a task, acquires a claim or impersonates
an owner. Its owner field is attribution metadata, not write authority.

## Decision boundary

1. Persist the message and resolve the existing recipient/visibility/thread
   scope. No cross-pod context or private memory enters the prompt.
2. Resolve deterministic rules once. A rule hit bypasses inference entirely.
3. For a non-rule message, reserve one decision record under unique
   `(podId, messageId)`. Store policyRevision as metadata, never as part of
   uniqueness: a policy rollout cannot classify the same message again. Concurrent producers share that record;
   neither each target nor each backend replica makes another call. Reservation
   failure goes to digest. Reserve a terminal deadline at admission. At expiry,
   recovery may only commit the durable digest fallback; it must never issue
   another inference request, even if the holder crashed before sending one.
   Compare-and-set on the reservation token prevents a late holder from
   replacing that terminal fallback. No lease reclaim permits a second call.
4. One LiteLLM request with an end-to-end 2,000 ms deadline, no automatic retry,
   tool use or alternate-model fallback. The selected route/key must disable
   provider/router fallbacks; record the actual upstream deployment from proxy
   logs, because the requested model name alone does not establish identity.
5. Validate the JSON locally, even when the provider claims strict schema.
   Unknown IDs, extra keys, duplicate targets, over three wakes, wrong owner
   kind/ID pairing, truncation, refusal, HTTP error and timeout all become
   `{wake:[], digest:true, owner:{kind:'none',id:null}}`.
6. Recheck active installation, pod visibility and current thread exclusions
   before committing any model wake. A late result cannot override a fallback
   already committed by the deadline. Use idempotent receipt keys so producer
   retries cannot duplicate the chosen effects.

For a valid decision, `wake` names up to three eligible seats. `digest` governs
non-woken eligible seats; false means no extra ambient receipt, not deletion of
the source message or existing unread events. Woken seats still get the actual
message through the established addressed-event frame and claim discipline.
Author self-wakes, bot-loop controls and muted/unfollowed-thread scope remain
enforced outside the model. A human owner may be attributed but is never an
agent wake target.

Implementation surfaces: `agentMentionService.enqueueMentions` and its ambient
fan-out; `messageDeliveryModeService.addressedMessageTargets` remains the rule
floor. Add an isolated decision service and a durable decision model. Do not
send classifier traffic through `llmService.generate` without first removing
its provider-fallback behavior for this call. A dedicated LiteLLM-only boundary
retains usage, deadline and deployment attribution.

## Prompt and schema

The benchmark's `SYSTEM` string and `decisionSchema` in
[`scripts/benchmark-wake-router.mjs`](../../scripts/benchmark-wake-router.mjs)
are the executable proposal. All message text, task titles and context strings
are untrusted data in a separate JSON user message. No tools or secrets.

Context contains `seats:[{id,role}]`, `humans:[{id}]`, current open
`rows:[{id,title,assignee,prUrl}]`, live `claims:[{threadId,seatId,expiresAt}]`,
and the source message `{id,author,content}`. IDs come from the resolved pod
scope; labels do not authorize delivery. Production context needs an explicit
size cap. If eligible rows/claims cannot fit, digest rather than silently
truncating ownership evidence. Input goal is about 2,000 tokens; measure actual
usage before treating that as a budget.

Output:

```json
{"wake":["seat-id"],"digest":true,"owner":{"kind":"seat","id":"seat-id"}}
```

Owner kind is `seat`, `human` or `none`; none requires null ID. IDs must match
their kind. The local validator rejects unknown targets and extra properties.
Structured-output support and reasoning-disabled behavior must be verified on
the actual LiteLLM deployment, not inferred from a provider family name.

## Candidate prices and latency study

Public catalog snapshot checked 2026-10-24 at
[OpenRouter's models API](https://openrouter.ai/api/v1/models). USD per million
tokens, no cache discounts; estimate per 1,000 messages assumes 2,000 input and
40 output tokens each. These are catalog estimates, not our proxy's billing.

| Candidate | Input / output | Estimate / 1k | Measured p50 / p95 |
| --- | ---: | ---: | --- |
| GPT-6 Luna | $0.10 / $0.50 | $0.2200 | Not measured |
| Claude Haiku 5.5 | $0.10 / $0.50 | $0.2200 | Not measured |
| Qwen3.7 Flash | $0.03 / $0.13 | $0.0652 | Not measured |
| DeepSeek V4 Flash 0423 | $0.091 / $0.182 | $0.1893 | Not measured |
| DeepSeek V4.1 Flash 1017 | $0.15 / $0.60 | $0.3240 | Not measured |

The prior row's DeepSeek V4 Flash estimate used $0.042/$0.169; the current
catalog differs. The checked-in LiteLLM config has `deepseek-v4-flash` and
`deepseek-flash-1017`, but no Luna/Haiku-5.5/Qwen3.7 group. Actual deployed
availability still needs the proxy's model list and one authenticated probe.
Do not choose batch variants or a variable-price model-selection router.

There are 200 distinct real messages saved privately, never in this repository.
This first sample includes rule-addressed messages and uses a current context
snapshot: it supports latency/schema measurements, not historical attribution
accuracy. A second labeled evaluation must apply historical rule state and
score only non-rule messages before enabling model routing.

Run each available candidate sequentially over exactly the same 200 IDs, with
an isolated, budget-limited LiteLLM key that can access only that deployment.
Disable reasoning where supported, pin the effective route and record those
settings alongside results. No OpenRouter credential renewal is required to
measure a working direct LiteLLM route. A seat-scoped runtime token is not a
LiteLLM inference credential and must never be sent to that service.

```sh
# Export LITELLM_BASE_URL and a scoped LITELLM_API_KEY through the operator's
# normal credential channel. INPUT and CONTEXT are private local files.
node scripts/benchmark-wake-router.mjs "$INPUT" "$CONTEXT" \
  deepseek-flash-1017 0.15 0.60 > "$RESULTS"
node --test scripts/__tests__/benchmark-wake-router.test.mjs
```

The harness never enqueues or writes to the board. It records message ID,
requested/returned model, HTTP status, decision, latency and usage, without
source text, provider error text or credentials. Keep results private. Summary
reports latency over all attempts and valid responses separately, timeout rate,
and usage coverage. Missing timeout/error usage is unknown cost, not free.
Output defaults to 128 tokens. Set WAKE_BENCH_MAX_TOKENS explicitly (1–16384)
when a candidate needs a larger completion budget; this does not extend the
2,000 ms deadline. WAKE_BENCH_FORMAT=json_object selects schema-less provider
output while preserving local validation. Default is json_schema. Unsupported
formats fail on that single call, with no retry. The summary records these
settings. WAKE_BENCH_REASONING_EFFORT=none explicitly disables reasoning on
a compatible route; unset leaves the provider default. Record actual usage rather than assuming the 40-token price example. Reconcile costs against LiteLLM logs, including timed
out requests and any unexpected upstream retries.

### First measured candidate (SRE, 2026-10-24)

Source: SRE's own run, relayed in TASK-442's 14:05Z update. These are reported
measurements, not a run performed by this writer. Same private 200-message
fixture and current context described above; not an attribution accuracy score.

| DeepSeek flash-1017 configuration | Attempts | Valid | p50 / p95 wall time | Outcome |
| --- | ---: | ---: | --- | --- |
| Strict json_schema, 2 s | 200 | 0 | Not supplied | 200 HTTP 400, upstream format unsupported |
| json_object, 2 s (cap not supplied) | 200 | 0 | ~2002 / ~2002 ms | 197 timeout, 2 response_error, 1 invalid_decision |
| json_object, 10 s characterization, 256-token cap | 30 | 0 | 2531 / 3312 ms | All truncated/invalid; minimum 2301 ms |

The characterization used mean 10,504 prompt tokens and hit the 256 completion
cap on every response. It cannot establish latency to a *valid* decision.
The original json_object prompt did not explicitly define the full decision
shape. That omission is fixed in this PR, but the reported validity rate is
confounded by both that prompt and truncation; it cannot establish intrinsic
model accuracy. No repeat benchmark is authorized.
The network path was laptop → Cloudflare → cluster → LiteLLM → provider.
In-cluster latency has not been measured, and these data do not isolate network
from model time. Reject this tested configuration for the 2 s pilot; neither
raising the cap nor moving the caller has been shown to meet the contract.
Known usage from three responses implies about $0.005; timeout billing remains
unknown. SRE reports the run stayed within its $0.50 scoped budget.

### Second candidate: GPT-5.4 nano (unavailable)

[Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-nano),
checked 2026-10-24: standard uncached input $0.20/M, output $1.25/M.
Structured outputs are supported; reasoning supports `none` (default), so
verify the deployed LiteLLM route preserves that setting rather than assuming
this family is intrinsically non-reasoning. Proxy availability/billing and
actual latency remain unverified.

At 2,000 input + 40 output tokens the estimate is $0.45/1k messages.
At the observed 10,504 input + a 128 output cap it is $2.2608/1k,
or $0.45216 for 200 calls. This is an estimate using a mean, not a spend bound.
A 256 cap raises that estimate to $0.48416; 512 raises it to $0.54816,
above the existing $0.50 authorization. Retain the hard key budget; budget refusals remain errors and must not be
retried to finish a sample.

Lily approved one single-model $0.50 Nano study on 2026-10-24, with the key
revoked afterwards. SRE's 14:09Z TASK-442 update reports no healthy deployment
for either the direct or Codex-routed Nano alias. The key was minted and
revoked with approximately zero spend. There are no Nano latency, usage or
validity measurements: unavailability is not a measured deadline failure.
The healthy DeepSeek routes do not provide a passing measured configuration;
the remaining tiny-model route has unverified structured-output support.

### Decision: retain rules-only routing; park TASK-442

Stop after these two candidates, per Lily's 14:09Z direction. No third model
benchmark, credential repair or provider expansion is authorized by this study.
Lily ruled at 14:10Z that existing deterministic rules and ambient digests stay active,
with model routing disabled. This preserves addressed wakes without adding a
known failing or unavailable inference dependency. It does not solve semantic
ownership in messages that match no rule; that remains an explicit limitation.

TASK-442 is parked until a fast structured-output model is servable. A later
model experiment needs a healthy, approved deployment and a fresh study decision. The proposed production contract and pilot bars below remain
requirements for that future work, not approval to implement or activate it.
This PR is only a design, offline script and tests (Tier 1, one seat gate).
The final gate should verify the reported measurements, unknowns, cost math,
privacy controls and the rules-only recommendation. Production integration
would still require the two Tier 2 gates specified below.

## Pilot and proof before activation

Start in shadow mode: deterministic routing stays in effect; classifier
decisions are logged without effects. Label 200 non-rule messages with expected
recipients and attribution, including historical asks, handoffs, settled chat,
quoted mentions, prompt injection and similar display names. Measure missed
asks and needless wakes against rules alone; never infer correctness from
agreement with an unlabeled current-state replay.

Proposed activation bar, to ratify with the measured table: zero lost rule wakes
(guaranteed structurally), no out-of-scope recipients, at least 99% valid JSON,
at most 5% deadline fallbacks, p95 valid response below 2 s, and no missed P0/P1
asks in the labeled pilot. Compare total cost including incremental seat runs,
not just cheap inference. Track spawn/h, missed-ask rate and USD per 1k messages
under the same pod/workload window. A cheaper model that wakes extra expensive
seats can lose overall. Turning the flag off must restore today's behavior
without deleting messages, unread state, ownership history or decision logs.

Telemetry per decision: pod/message/policy revision, rule-or-model, matched rule
IDs or model/deployment, wake IDs, digest flag, attributed owner, duration,
input/output tokens, actual or explicitly estimated cost, outcome/fallback
reason and resulting event IDs. No raw message bodies in general logs. Decision
completion uses compare-and-set so a timeout and a late answer cannot both win.

Production PR is Tier 2: two seat gates, after CodeRabbit. Required tests include
rule bypass (zero inference calls), concurrent one-call reservation, crash
fallback, invalid IDs/JSON, timeout versus late-result race, lifecycle changes
between classification and enqueue, thread/private-pod isolation, opt-out/flag
rollback, duplicate producer delivery and owner metadata not mutating claims.
