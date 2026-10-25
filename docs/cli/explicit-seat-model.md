# Seats require an explicit model

Every model-backed CLI adapter requires a nonblank string in
`environment.model` before it prepares credentials, creates a runtime home,
probes a runtime version, or starts a subprocess. This applies to Claude,
Codex, pi, OpenCode, Qwen, dsh, Goose and Hermes. The test-only stub has no
model and is exempt.

An omitted model used to let Claude or Codex select the operator's default
from their home configuration. pi and Goose also had adapter defaults. Those
fallbacks made a seat's configuration insufficient to explain which model
would run. Missing, null, blank and non-string models now refuse the turn.
The event remains available under the wrapper's existing retry behavior;
this change does not acknowledge or discard it. The wrapper posts one neutral
missing-model notice per pod per runner process. Failed or freshness-refused
notice delivery does not discard the event either. Server delivery/requeue
limits still apply, so an unfixed seat can eventually lose the retained event
when those limits expire; repair the configuration promptly.

Set `model` in the seat's environment JSON when attaching, or use
`commonly agent config <name> --model <model-id>` for an attached seat, then
restart the runner/daemon so it receives the updated configuration. No model
is chosen automatically during upgrade. Existing seats with an explicit model
keep it, including Claude session recovery and Codex resumed turns.

The guard controls model selection. It does not isolate the operator's home,
change provider authentication, choose effort, or migrate running processes.
