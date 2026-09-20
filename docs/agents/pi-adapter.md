# The `pi` adapter — a wrapper seat on any OpenAI-compatible model

`commonly agent attach pi` / `commonly agent run <seat>` with `"adapter": "pi"` runs
the seat on the [pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`)
instead of `claude` or `codex`. pi brings its own coding tools (`read`, `bash`,
`edit`, `write`), talks to any OpenAI-compatible endpoint, and keeps a
resumable session per pod — which is what a code-writer seat needs and what
neither of the other two harnesses gives us off ChatGPT/Claude quota.

For a persistent seat, register/install the daemon and place the agent through
Bring your own agent → On my computer in the web app; the daemon adopts that
server-marked request. `commonly agent attach` + `commonly agent run` remains
the separate foreground path for a one-off session.

## Why (2026-09-18)

The Luna code-writer seats (`kai`, `quill`, `sprint-impl`) ran `codex` on the
operator's ChatGPT OAuth. When that quota ran out (`You've hit your usage
limit`, circuit open every 15 min in `~/.commonly/logs/kai.log`) every code
lane stalled. Sam's call: replace them with DeepSeek V4.1 Flash, which we
already pay for and already route — LiteLLM serves it as `deepseek-v4-flash`
(upstream id `deepseek-flash`; `deepseek-v4-flash` is the accepted legacy
alias) and the hosted Scout/Recorder run on it.

Measured before choosing the harness, all on this laptop against
`https://litellm.commonly.me`:

| harness | result on `deepseek-v4-flash` |
|---|---|
| codex 0.153 (laptop) | **fails every turn** — codex sends a `namespace`-type tool DeepSeek's API rejects (`tools[7].type: unknown variant namespace`), with every feature flag off |
| codex 0.133 (cloud pin) | not tried on the laptop; predates the namespace tool but is two minor versions behind |
| pi 0.84 headless | wrote `greet.py` with `write`, ran it with `bash`, answered; a second turn resumed the session and recalled a codeword |
| pi + this adapter + bridge | called the real `commonly_get_started` and `commonly_get_messages` through `@commonlyai/mcp` and answered in 5.5 s |

pi was already the hosted turn engine (ADR-021, `engine: 'pi'`); this adapter
is pi as a wrapper, ADR-005's contract, one file plus a bridge.

## How it runs

```
pi -p --mode json --no-extensions --no-skills --no-prompt-templates --no-themes
   --provider litellm --model deepseek-v4-flash --thinking xhigh
   --session-dir ~/.commonly/pi-homes/<hash>/sessions
   (--session-id <uuid> | --session <uuid>)
   -e cli/src/lib/adapters/pi-commonly-mcp.mjs
   "<memory preamble + prompt>"
```

- **Sessions.** First turn `--session-id <uuid>` (creates it); later turns
  `--session <uuid>` (pi refuses `--session-id` together with `--continue`).
  The wrapper persists the id per (agent, pod) exactly as for codex.
- **Provider.** A per-seat `models.json` at
  `~/.commonly/pi-homes/<sha256(agent)[:20]>/agent/models.json`, pointed at by
  `PI_CODING_AGENT_DIR` — never the operator's `~/.pi`. The key is an env
  reference (`"apiKey": "$COMMONLY_LITELLM_KEY"`), so no secret is written.
  Default provider: LiteLLM at `https://litellm.commonly.me/v1`,
  `openai-completions`. Override per seat in the token file:

  ```json
  "environment": {
    "model": "deepseek-v4-flash",
    "effort": "xhigh",
    "provider": { "name": "litellm", "baseUrl": "http://litellm:4000/v1", "api": "openai-completions", "apiKeyEnv": "COMMONLY_LITELLM_KEY" }
  }
  ```

  (`baseUrl: http://litellm:4000/v1` is the in-cluster form for a cloud seat.)
- **Effort → thinking.** `none/off → off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max` map 1:1; anything else is omitted and pi picks its default.
- **Commonly tools.** `environment.mcp` (the same stdio entries claude and
  codex use, `${COMMONLY_API_URL}` / `${COMMONLY_AGENT_TOKEN}` filled at
  spawn) is written into pi's **fd 3** — a pipe the adapter writes and ends at
  spawn — and the extension `pi-commonly-mcp.mjs` reads it to EOF at load,
  starts each server, lists its tools and registers every one with pi under its
  own name. The client (`pi-mcp-client.mjs`) is a four-method newline-JSON-RPC
  client, no SDK. The token is never on argv and never in the child's
  environment: an environment is readable back whole by any same-user child
  (`ps eww $PPID`, `/proc/$PPID/environ`) no matter what the process deletes
  from its own copy, which is why it is not the channel — and a pipe is consumed
  by the read, so nothing outlives it. Measured on pi 0.84.1: pi does not close
  inherited descriptors before extensions load, and its bash/exec spawns pass a
  three-element stdio list, so a shell tool child never inherits fd 3. `typebox`
  resolves only inside pi's loader, which is why the extension is split from the
  client jest tests.
- **Reply.** stdout is NDJSON; the reply is the text of the last assistant
  `message_end`. Tool-call messages and tool results are not text. A non-zero
  exit with no assistant message rejects with pi's `error` event text (so the
  wrapper's quota classifier still sees `usage limit` when it is one).
- **Timeout.** `COMMONLY_AGENT_RUN_TIMEOUT_MS` or 15 min, SIGTERM, same as codex.

## Switching a seat (laptop)

0. **Refresh the workspace first — it is what the seat reads.** pi loads
   `AGENTS.md` / `CLAUDE.md` from its cwd (`environment.workspace.path`), and
   that clone is the copy the seat obeys, not the repo on main. Measured
   2026-09-18 before the first switch: `kai`'s clone was 400 commits behind
   main with an 08-26 CLAUDE.md, `sprint-impl`'s sat on a feature branch 738
   behind, `quill` had no clone. A merged rule is published, not adopted,
   until the file the reader loads carries it (GTM rule 30). So:
   `git -C <workspace> stash` any dirty seat work (never discard it),
   `checkout main && pull`, and confirm the instruction file's mtime matches
   the repo's before the first pi turn.
1. Mint a LiteLLM virtual key scoped to the model, in the LiteLLM pod so the
   master key never leaves it:
   `POST /key/generate {"key_alias":"laptop-codex-seats-deepseek","models":["deepseek-v4-flash"],"max_budget":20,"budget_duration":"30d"}`
   — store it at `~/.commonly/bin/litellm-seat-key` (0600).
2. Put it in the seat's process env as `COMMONLY_LITELLM_KEY` (the launchd
   plist / `revive-fleet.sh` export). The adapter refuses to spawn without it.
3. In `~/.commonly/tokens/<seat>.json`: `"adapter": "pi"`,
   `environment.model = "deepseek-v4-flash"`, keep `effort`, keep `mcp`.
4. Restart the seat. First turn shows `[<seat>] spawning pi`; the seat's home
   appears under `~/.commonly/pi-homes/`.

Rotate a seat's session the same way as for codex (delete the pod entry in
`~/.commonly/sessions/<seat>.json`); pi keeps its own JSONL under the seat
home's `sessions/`.

## Cloud seats

`cloud-codex-*` pods pin codex 0.133 through LiteLLM's `/v1/responses` bridge
(`codex-cli/gpt-5.4`). To run one on DeepSeek, either keep codex 0.133 and set
`model = "deepseek-v4-flash"` (the bridge returns `reasoning`, `message` and
`function_call` items correctly for it — verified from inside the LiteLLM
pod), or install pi in the image and set `COMMONLY_ADAPTER=pi` with the
in-cluster provider block above. Neither is wired yet; cody is parked at
`replicas: 0`.

## Not done here

- No pi in CI: the adapter's jest suites mock the binary; the bridge client is
  tested against a fake stdio server. The live proof is manual.
- Memory summaries: the adapter returns `text` and `newSessionId` only.
- Public-trust sandboxing (`environment.sandbox.trust: 'public'`) is not
  implemented for pi; do not attach a pi seat to a stranger-readable pod.
