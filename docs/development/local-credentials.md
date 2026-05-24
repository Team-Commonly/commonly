# Local Credentials

Credentials and env flags used by Commonly's local development paths.
This focuses on the developer workflows behind the Phase 2
local-dev-parity sprint: default compose, local CLI wrappers, and the
optional local clawdbot gateway path.

## TL;DR

- Fresh `./dev.sh up` can boot without third-party credentials if you
  stay on the default profile.
- For day-to-day local agent work, start with `GITHUB_PAT`.
- Add `LITELLM_API_KEY` only when you opt into the local clawdbot path
  or otherwise need a LiteLLM virtual key.
- Discord, Slack, Telegram, Tavily, Brave, Firecrawl, and Deepgram keys
  stay optional and only gate the subsystems that use them.

## Required For Local Agent Work

### `GITHUB_PAT`

Used by dev agents and local wrappers when they need to clone, fetch,
push, or open PRs against `Team-Commonly/commonly`.

- Obtain: GitHub fine-grained personal access token
- Resource owner: `Team-Commonly`
- Minimum permissions:
  - `Contents`: Read and write
  - `Pull requests`: Read and write
  - `Metadata`: Read
- Store in `.env` as `GITHUB_PAT=ghp_...`
- Quick verification, if `gh` is installed:

```bash
GH_TOKEN="$GITHUB_PAT" gh api repos/Team-Commonly/commonly --jq .full_name
```

Expected result:

```text
Team-Commonly/commonly
```

## Conditionally Required

### `LITELLM_API_KEY`

Required for the local clawdbot parity path. The target Phase 2 shape is
that this is only needed when `COMMONLY_LOCAL_CLAWDBOT=1`; until that
gate lands, treat it as required whenever you manually start the
clawdbot profile.

Use a LiteLLM virtual key, not the master key. The verified recipe in
this repo is to port-forward the dev LiteLLM Deployment and call
`POST /key/generate` with the master key from the cluster secret.

```bash
LITELLM_MASTER_KEY=$(kubectl get secret api-keys -n commonly-dev \
  -o jsonpath='{.data.litellm-master-key}' | base64 -d)

kubectl port-forward -n commonly-dev deploy/litellm 14000:4000 &
PF_PID=$!

curl -s -X POST http://localhost:14000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"key_alias\": \"local-dev-${USER}\",
    \"models\": [
      \"openai-codex/gpt-5.4\",
      \"openai-codex/gpt-5.4-mini\",
      \"google/gemini-2.5-flash\",
      \"openrouter/nvidia/nemotron-3-super-120b-a12b:free\"
    ],
    \"max_budget\": 2,
    \"budget_duration\": \"24h\",
    \"metadata\": {
      \"purpose\": \"local-dev-parity\",
      \"owner\": \"${USER}\"
    }
  }"

kill $PF_PID
```

The response includes `"key": "sk-..."`. Store that in `.env` as
`LITELLM_API_KEY=sk-...`.

Notes:

- Keep the budget cap conservative. The local runtime audit used `$2 /
  24h` specifically to keep experiments bounded.
- `LITELLM_MASTER_KEY` is operator-only. Do not persist it in local
  `.env` files.

## Optional Provider And Integration Keys

### Model routing

- `OPENAI_API_KEY`
  - Needed only if you are intentionally bypassing the cluster LiteLLM
    path and testing direct OpenAI routing.
- `OPENROUTER_API_KEY`
  - Needed for direct OpenRouter routing.
- `GEMINI_API_KEY`
  - Needed when testing Gemini direct or when LiteLLM is disabled.
- `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`
  - Optional base URL overrides for provider clients that support them.

### Search and web skills

- `TAVILY_API_KEY`
  - Enables Tavily-backed search skills.
- `BRAVE_API_KEY`
  - Enables Brave web search defaults for agent runtimes.
- `FIRECRAWL_API_KEY`
  - Enables Firecrawl-backed fetch/scrape tooling.
- `DEEPGRAM_API_KEY`
  - Enables audio transcription providers for runtimes that use them.

### Chat integrations

- `DISCORD_BOT_TOKEN`
  - Enables the Commonly Discord bot path.
- `SLACK_BOT_TOKEN`
  - Enables Slack bot actions.
- `SLACK_APP_TOKEN`
  - Required for Slack Socket Mode.
- `TELEGRAM_BOT_TOKEN`
  - Enables Telegram webhook/runtime flows.

## Subsystem Gates

Defaults should stay off unless you are actively working in that area.

| Variable | Effect | Credential Pairing |
| --- | --- | --- |
| `COMMONLY_LOCAL_CLAWDBOT=1` | Opts into the local clawdbot compose path | `LITELLM_API_KEY` |
| `COMMONLY_LOCAL_SCHEDULER=1` | Opts into local heartbeat scheduler work | none for v1 |

## Troubleshooting

- `gh api` returns `403` or `404`
  - The PAT is missing Team-Commonly repo access or the required scopes.
- LiteLLM returns `401`
  - The virtual key is missing, expired, or the provider path is sending
    the request without the expected auth header.
- OpenClaw still fails against LiteLLM after setting a virtual key
  - This is the auth-profile/import gap being tracked in the Phase 2
    local-dev-parity work. Native and CLI-wrapper paths are already
    verified; the local clawdbot path is the one still being tightened.
- A local service never starts
  - Check whether its compose profile or env gate is enabled. The local
    parity work keeps optional subsystems off by default.

## Related Docs

- [Development Overview](./README.md)
- [LiteLLM](./LITELLM.md)
- [Clawdbot Runtime](../agents/CLAWDBOT.md)
- [Sprint Plan: local-dev parity + agent collaboration](../plans/sprint-2026-05-23-local-dev-and-agent-collab.md)
