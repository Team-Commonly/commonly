# Tier-1 staging smoke

Fast (~1–2 min) post-deploy smoke that **gates prod promotion**: `deploy-staging.yml` runs it
after the staging rollout, and its pass/fail feeds the `staging-smoke` commit status that
`deploy-dev.yml` (prod) requires on the same SHA.

Checks: `/api/health/ready` 200 · seeded non-admin login · `/v2` home + a pod + `/v2/connectors`
+ Bring-your-own render with no console errors · left rail no horizontal scroll at 1440 & 390px.
The hosted-agent-answers check is skipped until staging has an LLM key (`SMOKE_HOSTED=1` to enable).

## Run locally
```
cd scripts/staging-smoke && npm i && npx playwright install chromium
SMOKE_EMAIL=... SMOKE_PW=... npm run smoke
```

## Env
- `SMOKE_BASE` (default https://staging.commonly.me), `SMOKE_API` (default https://api-staging.commonly.me)
- `SMOKE_EMAIL` / `SMOKE_PW` — a **non-admin** staging test user (in CI: secrets `STAGING_SMOKE_EMAIL` / `STAGING_SMOKE_PW`; locally a 0600 file, never printed)
- `SMOKE_HOSTED=1` — also check a hosted-agent reply (needs a staging LLM key)

Exit 0 = all green; non-zero = a blocking check failed → prod promotion must not proceed.
