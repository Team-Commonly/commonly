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

Populate this file via a one-time export or UI ingestion process.

Backend endpoints:
- `GET /api/skills/catalog?source=awesome`
- `POST /api/skills/import` (requires `podId`, `name`, `content`)

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
