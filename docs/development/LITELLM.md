# LiteLLM Model Gateway (Dev)

LiteLLM provides an OpenAI-compatible API for multiple model providers.
In Commonly it is used as a **model gateway**, not an agent gateway.

## Start (docker-compose)

```bash
LITELLM_MASTER_KEY=dev-litellm-key \
OPENAI_API_KEY=... \
GEMINI_API_KEY=... \
  docker-compose -f docker-compose.dev.yml --profile litellm up -d
```

The proxy listens on `http://localhost:4000`.

## Config

Model routing is defined in:
- `external/litellm/config.yaml`

Edit the `model_list` to add/remove models.

## Commonly backend usage

Set these env vars so backend AI services route through LiteLLM:

- `LITELLM_BASE_URL` (ex: `http://litellm:4000` in docker)
- `LITELLM_API_KEY` (same value as `LITELLM_MASTER_KEY`)
- `LITELLM_CHAT_MODEL` (optional, defaults to `gemini-2.0-flash`)
- `LITELLM_DISABLED=true` to bypass LiteLLM and call Gemini directly.

To route **embeddings** through LiteLLM as well, set:

- `EMBEDDING_PROVIDER=litellm`
- `EMBEDDING_MODEL=text-embedding-3-large` (or any model name in your LiteLLM config)
- `EMBEDDING_DIMENSIONS=3072` (match the model’s output dimensions)

## Dev status endpoint

Use the dev-only endpoint to confirm LiteLLM + embedding config:

```
GET /api/dev/llm/status
```

## Example request

```bash
curl http://localhost:4000/chat/completions \
  -H "Authorization: Bearer dev-litellm-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```
