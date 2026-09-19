# Local credentials

Local development should boot with the smallest set of credentials for the
surface being tested. Keep `.env` ignored, use a low-budget virtual key for
model calls, and never commit tokens or operator identifiers.

## Commonly local stack

```bash
./dev.sh up
curl -fsS http://localhost:5000/api/health
```

The local stack can exercise the web/API path without third-party provider
keys. Add a provider key only when the feature under test needs it.

## Conditional credentials

| Credential | Needed for |
|---|---|
| `GITHUB_PAT` | local workflows that fetch/push Commonly or use `gh` |
| `LITELLM_API_KEY` | a local process that calls a LiteLLM gateway |
| `GEMINI_API_KEY` | direct Gemini calls when the gateway is not used |
| `OPENAI_API_KEY` | direct OpenAI/image tests when explicitly enabled |
| `DISCORD_BOT_TOKEN` | Discord provider tests against Discord |
| `SLACK_*` | Slack provider/OAuth tests |
| `TELEGRAM_*` | Telegram webhook/provider tests |

Use test fixtures or mocks for unit tests. For a gateway key, ask an operator
to issue a narrowly scoped virtual key; the LiteLLM master key is not a local
developer credential.

## Safety checks

```bash
git status --short
git check-ignore .env
env | grep -E '(_TOKEN|_KEY|PASSWORD|SECRET)' | sed 's/=.*/=<redacted>/'
```

Do not paste the output of a real credential check into chat. Rotate a key if it
appears in shell history, a log, a screenshot, or a commit.
