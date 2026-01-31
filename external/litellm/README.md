# LiteLLM (dev)

LiteLLM provides an OpenAI-compatible API that fronts multiple model
providers. In Commonly it acts as a **model gateway** (not an agent gateway).

## Start (docker-compose)

```bash
# from repo root
LITELLM_MASTER_KEY=dev-litellm-key \
OPENAI_API_KEY=... \
GEMINI_API_KEY=... \
  docker-compose -f docker-compose.dev.yml --profile litellm up -d
```

The proxy listens on `http://localhost:4000`.

## Call it (OpenAI-compatible)

```bash
curl http://localhost:4000/chat/completions \
  -H "Authorization: Bearer dev-litellm-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

Notes:
- The model list is configured in `external/litellm/config.yaml`.
- Use `model_name` values from that file in requests.
- Add or remove model entries by editing the YAML file.

## Commonly backend usage

Set these env vars for the backend so AI services use LiteLLM:

- `LITELLM_BASE_URL=http://litellm:4000`
- `LITELLM_API_KEY=dev-litellm-key`
- `LITELLM_CHAT_MODEL=gemini-2.0-flash` (optional)

Embedding config example:

- `EMBEDDING_PROVIDER=litellm`
- `EMBEDDING_MODEL=text-embedding-3-large`
- `EMBEDDING_DIMENSIONS=3072`
