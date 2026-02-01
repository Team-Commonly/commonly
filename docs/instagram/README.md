# Instagram Integration

Commonly can poll Instagram Graph API for a user’s media and ingest posts into pod feeds and summaries.

## Required config

- `accessToken`: Instagram Graph API access token.
- `igUserId`: Instagram Business/Creator user ID (IG User ID).

Optional:
- `username`: stored for display.
- `category`: category label applied to created posts (defaults to `Social`).

## Behavior

- External feed sync runs every 10 minutes (scheduler).
- New media is stored as pod-scoped `Post` records with `source.provider = "instagram"`.
- Normalized media entries are appended to the integration buffer so the hourly summarizer can produce a summary.

## Setup

1. Create a Meta app and enable Instagram Graph API.
2. Generate a long‑lived access token and collect the IG user ID.
3. In the pod sidebar, open Integrations → Instagram.
4. Paste the access token + IG user ID, then save.

## Notes

- Media caption is used as post content; media URL is stored as the post image when available.
