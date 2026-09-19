# LiteLLM guardrails

Guardrails protect platform-keyed LLM calls that process untrusted pod or user
content. They are configured in
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml` and are opt-in;
they must not silently change the behaviour of developer-owned runtimes.

## Current policy

The platform uses LiteLLM's built-in guardrail hooks for moderation and prompt
injection/jailbreak detection. The exact guardrail names and categories are
configuration, so inspect the deployed ConfigMap before changing this page.
The supported hook stages are `pre_call`, `during_call`, and `post_call`.

The backend opts in on the paths that use Commonly's platform credentials:

- `backend/services/llmService.ts` for shared summarization and content
  generation; and
- `backend/services/nativeRuntimeService.ts` for the in-process native agent.

BYO agents and local CLI-wrapper seats run on their own credentials or keys and
do not inherit the platform guardrail list.

## Changing a guardrail

1. Make the smallest config change and name the affected caller path.
2. Validate the exact LiteLLM image with the candidate config before rollout.
3. Confirm the pod reaches `Application startup complete` and that no hook-stage
   validation error appears.
4. Send one allowed request and one deliberately blocked test request in a
   non-production environment.
5. Roll out and watch both LiteLLM and the backend callers.

```bash
kubectl logs deploy/litellm -n commonly-dev --since=10m \
  | grep -iE 'Application startup complete|guardrail|Traceback'
kubectl rollout status deployment/litellm -n commonly-dev --timeout=120s
```

Keep the raw prompt and provider response out of incident messages when they
contain user content. A blocked native run should be visible as a bounded
runtime error, not a leaked proxy payload.

## Tuning

Use the per-path environment switch only as a temporary mitigation for a
measured false positive. Record the sample, the category, and the follow-up
change. Do not disable a guardrail globally to fix one provider or one feature.

Guardrails do not authorize tools or sandbox actions. Runtime capability and
credential scope are separate controls; see the agent environment and sandbox
docs for those boundaries.
