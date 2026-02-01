# X Integration

Commonly can poll X (Twitter) accounts and ingest posts into pod feeds and summaries.

## Required config

- `accessToken`: X API bearer token.
- `username`: X handle (without `@`).

Optional:
- `userId`: cached X user id (filled automatically after first sync).
- `category`: category label applied to created posts (defaults to `Social`).

## Behavior

- External feed sync runs every 10 minutes (scheduler).
- New posts are stored as pod-scoped `Post` records with `source.provider = "x"`.
- Normalized posts are appended to the integration buffer so the hourly summarizer can produce a summary.

## Setup

1. Create an X API app and generate a bearer token.
2. In the pod sidebar, open Integrations → X.
3. Paste the bearer token and username, then save.

## Notes

- Replies and retweets are excluded by default.
- Use the X developer portal to rotate or revoke tokens.
