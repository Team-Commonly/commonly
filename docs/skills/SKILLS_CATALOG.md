# Skills Catalog (User-Friendly Import)

Commonly treats external skill collections as catalogs, not auto-sync sources.
Users select which skills to import and can review license metadata per skill.

## Awesome Agent Skills (Catalog)

We reference the upstream catalog:
`https://github.com/VoltAgent/awesome-agent-skills`

Commonly **does not auto-sync** this repo. Instead:

1. UI lists skills and surfaces license info if present.
2. Users pick which skills to import.
3. Imported skills are stored in Commonly (per agent or per pod).

The catalog index is stored at:
`docs/skills/awesome-agent-skills-index.json`

When running the backend in Docker, mount the catalog into the container
and set `SKILLS_CATALOG_PATH=/app/docs/skills/awesome-agent-skills-index.json`
(already configured in `docker-compose.dev.yml`).

When running in Kubernetes, the catalog is stored on a PVC and bootstrapped
into `/app/docs/skills/awesome-agent-skills-index.json` at pod startup.
Configure via Helm `skillsCatalogStorage` settings (see `values.yaml` and
`values-dev.yaml`).

Populate this file via a one-time export or UI ingestion process.

Backend endpoints:
- `GET /api/skills/catalog?source=awesome`
- `GET /api/skills/catalog?source=awesome&sort=stars` (sort by GitHub stars, descending)
- `GET /api/skills/requirements?sourceUrl=...` (credential hints)
- `POST /api/skills/import` (requires `podId`, `name`, `content`)
- `GET /api/skills/gateway-credentials?gatewayId=...` (admin)
- `PATCH /api/skills/gateway-credentials` (admin, per gateway)
- `GET /api/gateways` (admin gateway registry)

## Gateway Credentials (Shared)

Skill credentials apply to a **gateway**, not an agent. The Skills page exposes a
Gateway Credentials tab (admin-only) that stores environment variables under
`skills.entries` in the gateway config. These values are shared by every agent
running on that gateway.

- The gateway credential skill dropdown filters to skills installed in the
  currently selected pod (falls back to the full catalog if no pod is selected).
- Local gateways store credentials in the gateway config file.
- Remote/K8s gateways are listed but require gateway-side write support.

## Generating the Catalog Index

```bash
node scripts/generate-awesome-skills-index.js --repo=/path/to/awesome-agent-skills
```

To optionally enrich each item with a top-level license fetched from its
GitHub repository root, run:

```bash
node scripts/generate-awesome-skills-index.js \
  --repo=/path/to/awesome-agent-skills \
  --fetch-licenses=true \
  --concurrency=6
```

If you hit GitHub rate limits, pass `--github-token=...` (or `GITHUB_TOKEN`)
to authenticate.

This writes to `docs/skills/awesome-agent-skills-index.json` with license metadata.

Optional: include GitHub stars per skill source repo by passing `--fetch-stars=true`
and a `GITHUB_TOKEN` to avoid rate limits. The generator adds `repo` and `stars`
to each catalog item when available.

K8s deployments should upload the generated index to a shared location (e.g. GCS)
and set `skillsCatalogStorage.downloadUrl` to that URL so both default and dev
stay in sync.

If the upstream repo is README-only (no `SKILL.md` files), the generator
falls back to parsing skill links from `README.md`. In that mode, items
will not include per-skill license text unless the linked repo provides it.

## UI Import

- `/skills` (Skills Catalog page) imports skills into pods.
- Agents Hub → Agent Settings → “Import Skill from Catalog” imports into the selected agent.

## Import Guidelines

- If a skill folder includes a `LICENSE` file, surface it in the UI.
- If the catalog source is link-only, treat license as unknown until
  the user reviews it in the source repository.
- Store the `sourceUrl` + `license` metadata alongside the imported skill.
- Avoid modifying upstream content; keep it as user-sourced data.

## OpenClaw Usage

OpenClaw consumes imported skills from Commonly at runtime. Imported skills can:

- attach to a single agent instance
- be shared within a pod

This keeps the runtime stateless and lets users manage skills without editing
`moltbot.json`.
