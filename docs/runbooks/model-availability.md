# Instance model catalogue and route health

`backend/services/modelAvailability.ts` is the shared hosted/native model list.
It reads LiteLLM's `/model/info` and `/health` using the server credential, caches
one snapshot for five minutes, and shares a pending refresh between concurrent
readers. A subsequent read after expiry refreshes both inputs. No model request
is made for each picker interaction. `/health` may make real low-token probes;
its result is separate from gateway readiness or a configured route list.

The catalogue includes discovered chat/completion/responses routes and retains
previously offered choices, plus routes discovered earlier in the process.
A removed route stays visible as unavailable. New routes appear without code
changes. Status is per public route group: at least one matching healthy
deployment is required. Health deployment IDs prevent a good key on one route
from masking a rejected key on another. Older health responses without IDs are
accepted only when the upstream model identifies a single deployment; ambiguous
results remain unconfirmed.

The public shape contains model ID, label, provider group, availability, a fixed
reason and snapshot time. Provider errors, keys, endpoint URLs, budgets and
request bodies are never returned. Reasons distinguish rejected credentials,
rate limits/quota, failed checks, missing routes and unconfirmed health. Missing
configuration, missing health or a failed refresh never preserves stale green.

Consumers:

- Admin global integrations returns `modelCatalog` alongside existing policy;
  the backend and agent model pickers derive choices from that list. A saved
  missing/unhealthy model remains visible. No replacement is selected when a
  provider changes. Periodic catalogue refresh does not overwrite policy edits.
- Authenticated `GET /api/registry/models` supplies the same snapshot to hosted
  model override choices and refreshes them every five minutes.
- `GET /api/registry/presets` includes the same catalogue and each hosted
  recommendation's status. BYO recommendations are explicitly scoped to BYO;
  gateway failures never mark them unavailable.
- Local CLI model inventories and the BYO form remain independent. They use the
  person's own runtime/account. CLI model arguments accept user-supplied IDs;
  they are not an instance model catalogue.

To restore availability, repair the actual provider route/credential and let the
next health refresh verify it. There is no manual availability flag. This
metadata does not change runtime routing, choose a fallback or migrate installs.

## Surface scan (2026-10-25)

Searched `frontend/src`, `cli/src` and `backend/routes` for `claude-`,
`recommendedModel`, and model picker/flag definitions. Admin `GlobalIntegrations`
and legacy `AgentsHub` hosted model choices now read the shared list. The retired
AgentsHub Presets tab is not reintroduced. Native settings display model/runtime
truth; local runtime controls consume the CLI inventory. `V2AgentBYO` offers
local aliases (`opus`, `sonnet`, `haiku`) and remains unchanged. Registry presets
carry scope-appropriate recommendation status, including local Claude Code.

LiteLLM contracts: [model health API](https://docs.litellm.ai/docs/proxy/health),
[deployment health implementation](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/health_check.py).

Browser evidence: [TASK-002 audit](../audits/shell-task-002/README.md).
