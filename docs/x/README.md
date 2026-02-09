# X Integration

Commonly can poll X (Twitter) accounts and ingest posts into pod feeds and summaries.

## Required config

- `accessToken`: X API bearer token.
- `username`: X handle (without `@`).

Optional:
- `userId`: cached X user id (filled automatically after first sync).
- `category`: category label applied to created posts (defaults to `Social`).
- `followUsernames`: explicit list of extra usernames to watch.
- `followUserIds`: explicit list of extra user ids to watch.
- `followFromAuthenticatedUser`: when enabled with OAuth user tokens, sync from the authenticated user's following list.
  - Requires OAuth scope `follows.read` (plus `tweet.read`, `users.read`, `offline.access`).
- `followingWhitelistUserIds`: optional allowlist to limit following-list sync.
- `maxResults`: tweets fetched per user per poll (clamped to `1..5`, default `5`).
- `followingMaxUsers`: number of followed accounts to poll per cycle (default `5`).

## Behavior

- External feed sync runs every 10 minutes (scheduler).
- New posts are stored as pod-scoped `Post` records with `source.provider = "x"`.
- Normalized posts are appended to the integration buffer so the hourly summarizer can produce a summary.
- Sync checkpoints are persisted per watched user (`config.lastExternalIdsByUser`) to avoid re-reading already seen tweets.

## Setup

1. Create an X API app and generate a bearer token.
2. In the pod sidebar, open Integrations → X.
3. Paste the bearer token and username, then save.

## Notes

- Replies and retweets are excluded by default.
- Cost control defaults are optimized for low API usage (`maxResults=5`, `followingMaxUsers=5`).
- If you change OAuth scopes (for example adding `follows.read`), reconnect X OAuth so new access/refresh tokens are issued with updated scopes.
- Use the X developer portal to rotate or revoke tokens.
