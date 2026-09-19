# Routing Claude requests through LiteLLM

Use this runbook when a Commonly-managed runtime must call Claude through the
cluster proxy. A local Claude Code installation normally uses its own
authentication and does not need this path.

## Request path

```text
managed runtime → LiteLLM → api.anthropic.com
```

The caller presents a LiteLLM virtual key. LiteLLM validates the key, applies
the model and spend limits, and uses the cluster's Anthropic credential for the
upstream request. The upstream credential must never be copied into a seat or
committed to the repository.

The model aliases and provider credentials are configured in
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml` and the
deployment's secret wiring. Check the deployed ConfigMap and pod environment
before documenting a model name; model aliases change independently of the
CLI.

## Provisioning checklist

1. Confirm the target runtime is intended to use the shared proxy and has an
   owner and budget.
2. Confirm the Anthropic secret is present in the operator's secret manager and
   has reached the LiteLLM pod through External Secrets.
3. Generate a virtual key with only the required model names, a short budget
   window, and a conservative spend cap.
4. Store the virtual key in the runtime's private secret, not in a token file
   checked into a workspace.
5. Restart the consumer if it reads `ANTHROPIC_BASE_URL` or the key only at
   process start.

The master key is used only from an operator-controlled port-forward:

```bash
kubectl port-forward -n commonly-dev deploy/litellm 14000:4000
curl -sS -X POST http://127.0.0.1:14000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"models":["<verified-model>"],"max_budget":20,"budget_duration":"30d"}'
```

Use a shell variable supplied by the operator; do not put a real key in the
command history or a document.

## Verify

Check the proxy health, then make one small request with the virtual key. A
401 from Anthropic usually means the upstream secret is missing or invalid; a
401 from LiteLLM usually means the virtual key is wrong or expired. A model
error means the alias is not present in the deployed config. Inspect LiteLLM
logs with a bounded time window and redact keys before sharing output.

## Local Claude Code

For a laptop session, unset any Commonly proxy variables unless the operator
explicitly supplied a proxy configuration:

```bash
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY
```

The local CLI wrapper's adapter and the Commonly MCP server are separate from
cluster-side LiteLLM routing. See [`LOCAL_CLI_WRAPPER.md`](../agents/LOCAL_CLI_WRAPPER.md)
and [`MCP_INTEGRATION.md`](../MCP_INTEGRATION.md).
