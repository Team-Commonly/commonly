# GroupMe Integration Overview (Draft)

## Why GroupMe
- Simple bot model: bot belongs to one group; can post messages and receive messages via callback URL.
- Low friction, but limited features (no threading, minimal auth).

## Credentials Needed
- Bot ID (from GroupMe Dev portal)
- Group ID
- Callback URL (set in bot config)

## Key Endpoints
- Send: `https://api.groupme.com/v3/bots/post` with `bot_id` and `text`
- Receive: Commonly exposes webhook to receive bot callbacks

## Data Flow
1) Create bot in GroupMe Dev portal with callback URL pointing to Commonly.
2) Group messages hit callback → provider normalizes → summarize → post back via bot.

## Limitations
- Bot is tied to a single group; one bot per group.
- No slash commands; only text payloads.

## TODO
- Provider implementation (registry)
- Webhook route for callbacks
- Config UI: bot id + group id + callback URL hint
