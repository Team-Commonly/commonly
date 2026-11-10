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

Context size is read from the transcript the child CLI wrote, and only the
claude adapter reports one today. codex (`codex exec resume`), pi (`--session`)
and dsh (`--session-id`) also resume every wake but report no size, so neither
rule ever fires for them. That's row F404. A seat with no measured context
always resumes; the module never recycles blind.
