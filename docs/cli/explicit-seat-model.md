# Explicit models for operator fleet seats

A person connecting their own CLI may use that CLI's own default model.
Without `COMMONLY_REQUIRE_SEAT_MODEL=1`, Claude, Codex, OpenCode and Hermes
pass a model argument only when `environment.model` declares one. Qwen and
dsh retain their existing provider/model configuration requirements, checked
before credential minting even with the flag off. pi and
Goose always require an explicit model because their adapters construct a
provider configuration; neither restores a hidden adapter default.

Operator fleet launchers must export `COMMONLY_REQUIRE_SEAT_MODEL=1` in the
runner environment before starting the CLI. This prevents fleet seats from
inheriting the operator's home model configuration. Set the flag when moving
each fleet launcher to the release containing this guard. The flag is read
from the runner process, not from a child environment declaration. It is off
unless its value is exactly `1`.

For opted-in runners, every model-backed adapter requires a nonblank string
in `environment.model` before credential minting, runtime-home preparation,
version probes or subprocess creation. The test-only stub is exempt.
The event remains unhandled and unacknowledged for the existing retry path.
One neutral missing-model notice is posted per pod per runner process.
Failed notice delivery also retains the event. Server delivery/requeue limits
still apply, so repair the configuration before retries expire.

Use `commonly agent config <name> --model <model-id>` and restart the runner
to load the repaired configuration. Explicit models remain pinned on Claude
recovery and Codex resumed turns. This setting controls model selection;
it does not isolate the operator's home or change provider authentication.

A BYO user with only the page-issued key can set `--model` and `--effort`
without logging into the CLI. The command uses the key saved by the first
`agent run`, updates the identity's owned BYO installations, and preserves the
rest of the local environment for the next restart. It requires a backend
with `PATCH /api/agents/runtime/configuration`; a failed request leaves the
local record unchanged. Existing owner logins continue using the Settings
write path, including for machine-managed agents.

The runtime-key endpoint accepts only model and effort. It requires an active
root credential with a recorded owner who remains the identity's sole
installer. Spawn keys, hosted agents, other identities and broader environment
changes are refused, and a refusal points at the agent's Settings, then Model.

A daemon seat's own key may also set its model (F178). The key must be the seat
root that the daemon of the machine the identity is bound to minted for its
owner: a spawn child, a key from another machine's daemon, or a page key for an
identity a machine now manages is refused. The model and effort are checked
against what that machine reports, as the Settings page checks them. The seat's own process holds this power too, through the seat-fallback key or,
under an unsandboxed harness, by reading the token file; a page-issued key
already gave a listener's process the same power. `--adapter` and `--env` still require
an owner login. A saved runtime key is used only for its recorded instance URL;
an `--instance` override resolving to another URL requires an owner login for
that instance and receives no fallback runtime-key request.
Legacy keys without a credential ledger row need the owner to
reissue a key through the page.

## When the provider refuses the model

When a turn fails because the provider will not run the model (claude's 403
"... is not available for this API key", an OpenAI-style `model_not_found`, or
a 404 whose body names a model), the wrapper posts one line in the pod naming
the model and pointing at the agent's Settings, then Model. Any other 403 or 404
posts nothing. The line is posted at most once per model per seat per hour,
recorded in `~/.commonly/sessions/<agent>.notices.json` so a restart does not
repeat it. The turn still fails and retries as before. Matcher and tests:
`cli/src/lib/model-unavailable.js`, `cli/__tests__/model-unavailable-hint.test.mjs`.
