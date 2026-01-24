# Google Chat Integration Overview (Draft)

## Why Google Chat
- Chat apps can join spaces (rooms) and DMs; receive events via HTTP; post via REST.
- Good for posting summaries into spaces and reacting to messages.

## Credentials Needed
- Service account JSON (for auth) or app credentials
- Verification token (for incoming requests) or use JWT verification depending on config
- Chat API enabled in Google Cloud project

## Key Endpoints
- Incoming webhooks: Google Chat sends events to app endpoint (messages, added_to_space, removed_from_space)
- Outbound: `https://chat.googleapis.com/v1/spaces/{space}/messages` (requires auth)

## Verification
- Prefer JWT verification of `Authorization: Bearer` signed by Google; alternatively use legacy verification token if configured.

## Data Flow
1) Create Chat app in Google Cloud; enable Chat API; set bot endpoint URL.
2) App invited to a space → receives events at webhook URL.
3) Commonly provider ingests events → normalize → summarize → post back via REST.

## TODO
- Provider implementation (registry)
- Webhook route with JWT verification
- Config UI: service account upload or fields, space targeting guidance
