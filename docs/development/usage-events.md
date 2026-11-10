# First-party usage events (D286)

Commonly records which screens signed-in people open and which buttons they press, by fixed name. Logged-out visitors are counted per page per day. It uses no third-party SDK, pixel or vendor, and never records typed text. This page covers how it works and the rules the server enforces. The setup-step records it builds on are in [byo-funnel-telemetry.md](byo-funnel-telemetry.md).

## Where things are

| Piece | File |
|---|---|
| Allowlists, consent, pod rules, caps, TTLs, purge | `backend/services/usageEvents.ts` |
| `POST /api/stats/ui-event` (signed in), `POST /api/stats/public-hit` (logged out) | `backend/routes/stats.ts` |
| Settings switch: `GET`/`PUT /api/users/me/usage-events` | `backend/routes/users.ts` |
| Published page paths the server counts against | `backend/config/publicPages.json` |
| App client: `trackUsage`, `trackUsageOnce`, `trackPublic` | `frontend/src/v2/utils/usageEvents.ts` |
| `app-open` and `screen-view` on every route | `frontend/src/v2/hooks/useUsageEvents.ts` |
| Logged-out counter on prerendered pages | `publicHitScript` in `frontend/scripts/generate-seo-pages.mjs` |

## Rules the server enforces

- **Names, screens, pages and ref codes come from server allowlists.** Unknown props are dropped, and props are enum-only with at most 4 keys. An unknown event name gets a 400 that never echoes what was sent. An unknown screen is stored as `other`. An unknown page or slug counts as `other`, and an unknown ref code as `other`.
- **The server sets `userId`, `at`, `isInternal` and `podKind`.** Copies in the request body are ignored.
- **Pods:** the server loads the pod and derives `podKind` from `Pod.type`. It keeps `podId` only for `chat` and `team` pods that pass `DMService.canViewPod`. Inside `agent-room`, `agent-dm` and `agent-admin` it stores only `{ name, screen, podKind }`. For a pod the person can't see, it stores nothing about the pod.
- **Consent:**
  - `DNT: 1` or `Sec-GPC: 1` drops every event on both endpoints, whatever the switch says.
  - `User.preferences.usageEvents` set to `true` records and `false` doesn't.
  - When it's unset, the region decides. Accounts carry no country, so the request's `CF-IPCountry` is used. The EU, EEA and UK are off until the person turns it on. So are Cloudflare's `XX` and `T1`, and a request with no country at all. Everywhere else is on.
- **Limits:**
  - `ui-event`: 120/min per real IP before auth and 60/min per person after.
  - `public-hit`: 60/min per IP.
  - At most 20 events per batch and 2,000 rows per person per UTC day.
  - The limiters skip under `NODE_ENV=test` unless `USAGE_LIMITS_IN_TEST` is set; `usageEvents.limits.test.js` sets it.
- **Storage:**
  - `ui_events` expires 90 days after the server-set `at`.
  - `ui_daily_counts` is keyed `{day, name, page, refTag, value}` with a count `n`. It holds nothing per visitor and expires after 13 months on `dayStart`.
  - Account deletion removes a person's `ui_events` on the self-serve path and in the deletion sweep.
- **Internal accounts are recorded and flagged with `isInternal`**, so reads can leave them out. These are admins plus the `USAGE_INTERNAL_USERNAMES` deploy setting, a comma list. The chart sets it from `backend.env.usageInternalUsernames`, on web and worker. In prod that value comes from its own GitHub Actions secret, `DEV_HELM_USAGE_INTERNAL`, a values file that Deploy Dev layers on; it isn't kept in `DEV_HELM_VALUES_PRIVATE`, because that whole-file secret can't be read back to edit one line. Set it as YAML, not `--set`, which splits on commas. Usernames never go in this repo. Until it's set, only admins are flagged, and our other accounts count as users.
- **Reads are aggregate-only, through ops-runner or admin.** No endpoint returns rows.

## Reading it: the daily usage report (F403)

`backend/scripts/usage-report.js` is the read Growth runs every day, on ops-runner through the prod-read wrapper:

```
growth-prod-read.sh backend/scripts/usage-report.js DAYS=14
```

- **Window:** `DAYS` is 1–90 UTC days ending today (default 7). `FORMAT=json` prints JSON instead of the tables.
- **What it prints:**
  - people active per day;
  - signed-in events per day by event, screen and step (`start=byo`), each with event and people counts;
  - logged-out hits per day by page, ref and value from `ui_daily_counts`.
- **Our own accounts are left out at read time:** the stored `isInternal` stamp, admins, `USAGE_INTERNAL_USERNAMES` and `USAGE_INTERNAL_PREFIXES`, read from ops-runner's env. A row recorded before a name was listed still drops. The header says how many events were left out.
- **A prefix shorter than 4 characters is ignored**, and the header says so, because a slip like `a` would drop real people from every read.
- **Counts only:** nothing it returns or prints carries an id, a username, an email or typed text. A test checks this.
- **It avoids newer aggregation operators**, deciding who is ours from a narrow `users` read, so it runs on whatever Mongo the instance has.

## The client

- **Events wait in memory** until `GET /api/users/me/usage-events` answers. If the switch is off, or the browser sends DNT or GPC, they're dropped.
- **Batches go by `fetch` with `keepalive`** and the usual Bearer header. They never use `sendBeacon` and never put a token in the body.
- **Screens are V2App route templates without `/v2`**, mapped by `screenTemplate`. A pod's id travels only as `podId`, for the server to check.
- **`trackPublic` is for the logged-out app pages** (`/register`, `/login`, `/invite/:token`). It sends nothing when a session token is present.
- **Prerendered pages** (`/`, guides, compare, use cases, legal) carry `publicHitScript`. It counts one `page-view` per load, plus a `cta-click` for links to register or pricing. It skips signed-in visitors and DNT/GPC, and sends no credentials. The app shell (`app.html`) doesn't carry it.

## Adding an event

1. Add the name, and an enum for each prop, to `UI_EVENTS` in `backend/services/usageEvents.ts`, and the name to `UsageEventName` in the client.
2. Call `trackUsage` or `trackUsageOnce` with fixed values only. Never pass something a person typed, a message, a file name or a URL with a query string.
3. Add a test that the value outside the enum is dropped.

When a published page is added or removed, regenerate `backend/config/publicPages.json` from `buildPageDefinitions`. The test `the backend knows every published page path` fails until you do.

## Allowlisted, not yet sent

`welcome-dismiss`, `hosted-install-click`, `hosted-install-result`, `agent-settings-open`, `runtime-model-save`, `agent-reply-seen`, `reaction-add`, `retry-click`, `board-open`, `task-open`, `decision-answer`, `empty-state-shown` and `stuck-help-click` are accepted but no surface sends them yet. `error-shown` isn't accepted, because the spec requires its code to be checked against the real error-code enum, which doesn't exist yet.
