# Messenger Integration Notes (on hold)

Meta has deprecated consumer Messenger platform features; group access is limited and high-risk for account flags. Proceed with caution and defer implementation until we have a Business App with proper review.

## Current Stance
- **Do not implement now**. Keep design placeholder only.
- If revisited, use Meta Graph API for Page-scoped messaging (page access tokens), not personal accounts.

## Minimal Design (future)
- Integration type `messenger` uses Page access token + App Secret Proof; webhook verification via `hub.challenge` similar to WhatsApp.
- Ingest-only mode: collect messages sent to the Page and summarize into pod.

## Risks
- Using personal tokens or unofficial methods can trigger bans. Avoid entirely.

