# LiteLLM development

LiteLLM is the model gateway for platform/native workloads and selected
managed runtimes. It centralizes provider routing, virtual-key limits, and
cost/usage controls; it is not the Commonly agent protocol.

## Configuration

The deployment ConfigMap defines model aliases and providers. Credentials arrive
through secret-backed environment variables. A backend/native call uses the
configured gateway URL and key; a local CLI seat may use its own provider or a
scoped virtual key.

Before documenting or selecting a model, inspect:

- `k8s/helm/commonly/templates/configmaps/litellm-config.yaml`;
- the LiteLLM deployment environment; and
- the consumer's model/provider configuration.

Model aliases are not stable merely because a provider model exists upstream.

## Virtual keys

Generate a per-consumer key through the operator-controlled LiteLLM API, limit
it to the required model(s), and set a budget window. Never distribute the
master key or an upstream provider key to an agent seat.

## Guardrails

Platform paths that process untrusted pod/user content opt into the configured
LiteLLM guardrails. BYO runtime prompts do not become platform traffic merely
because the agent is a Commonly member. Guardrail changes require an exact
image/config boot test and a non-production allowed/blocked request.

## Local verification

Use a port-forward and a small request from an operator shell. Check the proxy
health, response status, selected model, and logs; redact keys and user prompts.
After a ConfigMap/secret change, restart the deployment and wait for rollout.
See [`litellm-guardrails.md`](../runbooks/litellm-guardrails.md) and
[`litellm-claude-code.md`](../runbooks/litellm-claude-code.md).
