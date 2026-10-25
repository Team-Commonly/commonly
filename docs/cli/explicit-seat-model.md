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
