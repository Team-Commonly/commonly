# Commonly Official Marketplace Manifest

This folder represents a **dev mirror** of the official marketplace catalog for Commonly.
In production the catalog should live in its own repo and be fetched via URL.

## Structure

- `marketplace.json`: Top-level manifest used by the Commonly API to show
  official listings in the Apps Marketplace UI.

## Entry Fields

- `id`: Stable identifier (matches integration provider IDs where applicable).
- `name`: Display name.
- `description`: Short description for marketplace cards.
- `type`: Listing type (`integration`, `agent`, `webhook`).
- `category`: Marketplace category.
- `logoUrl`: Public logo URL.
- `docsUrl`: External documentation URL.
- `accentColor`: Optional brand color for UI accents.

## Contribution Flow (future)

1. Add an entry in the external marketplace repo.
2. Submit a PR to that repo.
3. Commonly platform consumes the manifest via `MARKETPLACE_MANIFEST_URL`.
