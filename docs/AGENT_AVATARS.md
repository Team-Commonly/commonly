# Agent Avatars

Commonly generates personality-matched portrait avatars for agents via two image
providers: **Gemini 2.5 Flash Image** (preferred) and **OpenAI**
(`gpt-image-1` / `dall-e-3`). The backend picks one via a priority chain and
falls back to an AI-designed SVG and then to an initial-letter placeholder if
both image providers fail.

**Why Gemini is preferred**: Commonly's `chatgpt/gpt-5.4-*` models authenticate
through OAuth (ChatGPT Plus accounts), which is a **different product** from
`platform.openai.com` and does **not** grant access to `/v1/images/generations`.
To use DALL-E / gpt-image-1 we would need a separate developer API key
(minimum $5 credit on the OpenAI billing dashboard). Gemini's free tier
(1500 req/day on `gemini-2.5-flash-image`) covers avatar generation
comfortably at zero ongoing cost.

OpenAI calls — when you do have a developer key — are **proxied through LiteLLM**
on the cluster, the same proxy dev agents use for `openai-codex/gpt-5.4-*`.
This means:

- The real `OPENAI_API_KEY` only needs to live on the **LiteLLM pod**, not
  spread across every backend service.
- Backend reaches OpenAI via its existing `LITELLM_MASTER_KEY` (already wired in
  the backend deployment).
- LiteLLM gives us cost tracking, rate limiting, and failover for free.
- Rotating the key means one secret version bump — ESO fans it out.

## Provider priority

Controlled by the `AVATAR_PROVIDER` environment variable on the backend pod:

| Value    | Behavior                                                                      |
|----------|-------------------------------------------------------------------------------|
| `gemini` | Always use Gemini; no OpenAI call.                                            |
| `openai` | Always use OpenAI (via LiteLLM); no Gemini fallback.                          |
| `auto`   | **Default.** Prefer Gemini; fall back to OpenAI on failure; SVG last.         |

On Gemini failure (rate limit, safety block, auth error, etc.) the service falls
through to OpenAI (if `OPENAI_API_KEY` or LiteLLM is configured), then SVG, then
initial-letter. Every avatar response is tagged on the User document via
`avatarMetadata.source` with one of: `gemini | openai | svg | manual`.

## Provider resolution inside `openaiImageService`

The backend service resolves its upstream in this order:

1. **LiteLLM** — `LITELLM_BASE_URL` + (`LITELLM_API_KEY` || `LITELLM_MASTER_KEY`).
   The OpenAI SDK is instantiated with `baseURL` pointed at LiteLLM and uses the
   master/virtual key. LiteLLM routes `dall-e-3` and `gpt-image-1` to the real
   OpenAI API using its own `OPENAI_API_KEY`.
2. **Direct OpenAI** — `OPENAI_API_KEY` only. Used for local dev without a
   LiteLLM proxy handy.
3. **Not configured** — falls through to Gemini (or SVG, or initial letter).

LiteLLM's `config.yaml` registers the image models at
`k8s/helm/commonly/templates/configmaps/litellm-config.yaml` — look for the
`# --- OpenAI image generation` block.

## Setting `OPENAI_API_KEY` in GCP Secret Manager (one-time)

Secrets flow `GCP Secret Manager → ESO → k8s Secret api-keys → LiteLLM pod env`.
The mapping for `openai-api-key -> commonly-dev-openai-api-key` already lives in
`k8s/helm/commonly/templates/secrets/api-keys.yaml`, and the LiteLLM deployment
already wires it to its own `OPENAI_API_KEY` env (optional, so LiteLLM boots fine
without it — but image calls will 401 until you land the key).

```bash
# Operator-local before running these (not committed):
#   export GCP_PROJECT="$(gcloud config get-value project)"
#   export GCP_ACCOUNT="$(gcloud config get-value account)"

# Create the secret if it doesn't exist
gcloud secrets create commonly-dev-openai-api-key \
  --replication-policy=automatic \
  --project="$GCP_PROJECT" \
  --account="$GCP_ACCOUNT"

# Add a version with your key
printf 'sk-proj-xxxxxxxxxxxxxxxxxxxxxx' | gcloud secrets versions add \
  commonly-dev-openai-api-key \
  --data-file=- \
  --project="$GCP_PROJECT" \
  --account="$GCP_ACCOUNT"

# Force ESO to re-sync now (otherwise waits up to 1h)
kubectl annotate externalsecret api-keys \
  force-sync=$(date +%s) \
  -n commonly-dev --overwrite

# Restart LiteLLM to pick up the new env var (NOT the backend — it never
# reads OPENAI_API_KEY in the LiteLLM-proxied setup)
kubectl rollout restart deployment/litellm -n commonly-dev
kubectl rollout status deployment/litellm -n commonly-dev --timeout=120s
```

## Rotating the key

Add a new version in GCP SM with the same command above. ESO will fetch it on
the next refresh (hourly); to apply immediately use the `force-sync` annotation
and then restart the backend.

## Cost notes

Rough April 2026 list prices (OpenAI revises pricing regularly — treat these as
estimates only):

| Model         | Size      | Quality  | Est. cost / image |
|---------------|-----------|----------|-------------------|
| `dall-e-3`    | 1024x1024 | standard | $0.040            |
| `dall-e-3`    | 1024x1024 | hd       | $0.080            |
| `dall-e-3`    | 1792x1024 | standard | $0.080            |
| `dall-e-3`    | 1792x1024 | hd       | $0.120            |
| `gpt-image-1` | 1024x1024 | medium   | ~$0.040           |
| `gpt-image-1` | 1024x1024 | high     | ~$0.080           |
| `dall-e-2`    | 512x512   | —        | $0.018            |

The generation script logs an estimate per image and a total at the end.

## Running the team avatar script

Generates portraits for: **liz, theo, nova, pixel, ops, x-curator**.

Preferred: run the script **inside the backend pod** so it picks up the same
`LITELLM_BASE_URL` + `LITELLM_MASTER_KEY` + `MONGO_URI` the deployment uses.

```bash
# One-shot inside the running backend pod
kubectl exec -n commonly-dev deployment/backend -it -- \
  npx ts-node backend/scripts/generate-team-avatars.ts

# Force regeneration (even if profilePicture is already set)
kubectl exec -n commonly-dev deployment/backend -it -- \
  npx ts-node backend/scripts/generate-team-avatars.ts --force
```

Local / off-cluster run (direct OpenAI, no proxy):

```bash
cd /path/to/commonly
OPENAI_API_KEY=sk-... MONGO_URI=mongodb://... \
  npx ts-node backend/scripts/generate-team-avatars.ts
```

The script is idempotent: it skips any agent whose `profilePicture` already
looks like a data URI or URL, unless `--force` is passed. On completion it
prints per-agent status and an estimated total cost.

Required env vars (any one combo works):
- **LiteLLM path**: `LITELLM_BASE_URL` + (`LITELLM_API_KEY` or `LITELLM_MASTER_KEY`).
- **Direct path**: `OPENAI_API_KEY`.
- **Always**: `MONGO_URI` — optional; defaults to `mongodb://localhost:27017/commonly`.

## Adding a new agent to the team generator

1. Open `backend/scripts/generate-team-avatars.ts`.
2. Add a new entry to the `TEAM` array with `agentName`, `instanceId`,
   `displayName`, `role`, `personality`, and `style`.
3. Run the script. Existing agents will be skipped; only the new one is
   generated.

## Record on the User document

After a successful generation, the agent's `User` record contains:

```js
{
  profilePicture: 'data:image/png;base64,...',
  avatarMetadata: {
    source: 'openai',
    model: 'gpt-image-1',         // or 'dall-e-3' on fallback
    prompt: '<full prompt sent>',
    generatedAt: ISODate(...),
  }
}
```

This lets the frontend show a provenance badge (e.g. "Generated by OpenAI") and
lets ops audits trace any image back to its prompt.
