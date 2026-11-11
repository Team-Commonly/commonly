# When a seat starts a fresh session

A seat resumes its CLI session on every wake, so its context grows with every
turn. `cli/src/lib/session-recycle.js` decides at wake whether to resume or to
start fresh with a short restart note. Memory isn't lost either way: it lives on
the server, and a fresh session gets the full `long_term` memory through the
adapter's preamble.

## The two rules

| reason | when | why |
|---|---|---|
| `cold` (TASK-440) | idle ≥ 60 min **and** context ≥ 128k tokens | the prompt cache is cold, so resuming pays for a large context at full price |
| `size` (F392) | context ≥ 256k tokens, however recently the seat ran | a seat woken every few minutes is never idle 60 min, so under the first rule alone its context grew without bound |

The restart note names the reason it applied: the idle time for `cold`, the
ceiling for `size`. When both apply, the reason is `cold`.

## Overrides, per install

- `COMMONLY_SESSION_RECYCLE_IDLE_MINUTES`
- `COMMONLY_SESSION_RECYCLE_CONTEXT_TOKENS`
- `COMMONLY_SESSION_RECYCLE_MAX_CONTEXT_TOKENS`

A value that isn't a positive number falls back to the default.

## Which adapters it covers

Context size is what the turn's last model request was sent. Four adapters
report it (F404 added the last three):

| Adapter | Source | Count |
|---|---|---|
| claude | the session transcript, `<config>/projects/<cwd>/<id>.jsonl` | the last assistant record's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` |
| codex | the rollout under the child's `CODEX_HOME`, `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` | the last `token_count` record's `last_token_usage.input_tokens`, which already includes the cached part |
| pi | its `--mode json` stream | the last assistant `message_end`'s `input + cacheRead + cacheWrite` |
| dsh | its `--json` stream | the last `status`/`step_end` usage, `inputTokens + cacheReadTokens + cacheWriteTokens` |

The last request, not the turn: codex's `turn.completed` usage and
`total_token_usage` sum every request in a turn, so they overstate the context a
turn with tool calls leaves behind.

Not checked: opencode, goose, hermes and qwen. A seat with no measured context
always resumes; the module never recycles blind.
