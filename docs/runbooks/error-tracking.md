# Error tracking

Commonly supports opt-in Sentry error reporting for the Express backend and
React frontend. The presence of a DSN is the runtime gate: without one, neither
SDK initializes and neither SDK makes network calls. The base Helm values keep
error tracking disabled for self-hosters.

## Create the Sentry projects

Create two projects in the Commonly Sentry organization so browser and server
errors can have separate ownership and alert thresholds:

1. Create a **React** project for the frontend.
2. Create a **Node.js / Express** project for the backend.
3. Copy each DSN from the project's **Settings → Client Keys (DSN)** page.

No performance-monitoring or Session Replay setup is needed. Commonly sets the
trace sample rate to zero and does not enable replay or tracing integrations.

## Provision dev credentials before enabling the chart

The `api-keys` ExternalSecret is atomic from the operator's point of view: one
missing `remoteRef` prevents the whole Kubernetes Secret from reconciling. The
backend DSN must therefore exist in GCP Secret Manager **before** a chart with
`errorTracking.enabled: true` is deployed.

Store the backend DSN as `commonly-dev-sentry-dsn`. Avoid putting the value on a
command line or in shell history:

```bash
read -rsp 'Backend Sentry DSN: ' SENTRY_BACKEND_DSN
printf '%s' "$SENTRY_BACKEND_DSN" \
  | gcloud secrets create commonly-dev-sentry-dsn --data-file=-
unset SENTRY_BACKEND_DSN
```

If the secret already exists, add a version instead:

```bash
read -rsp 'Backend Sentry DSN: ' SENTRY_BACKEND_DSN
printf '%s' "$SENTRY_BACKEND_DSN" \
  | gcloud secrets versions add commonly-dev-sentry-dsn --data-file=-
unset SENTRY_BACKEND_DSN
```

Store the React project DSN in the GitHub `dev` environment as the Actions
secret `DEV_SENTRY_FRONTEND_DSN`. The deploy workflow passes it only to the
frontend Docker build. The DSN is compiled into the enabled browser bundle, so
changing it requires a frontend rebuild.

```bash
read -rsp 'Frontend Sentry DSN: ' SENTRY_FRONTEND_DSN
printf '%s' "$SENTRY_FRONTEND_DSN" \
  | gh secret set DEV_SENTRY_FRONTEND_DSN --env dev \
      --repo Team-Commonly/commonly
unset SENTRY_FRONTEND_DSN
```

Backend instrumentation is deliberately the first module loaded by the Node
process. `SENTRY_DSN` must therefore be in the process environment before Node
starts (as it is in Kubernetes); a value loaded later from `backend/.env` will
not activate it.

Only after both values exist should `errorTracking.enabled` be set to `true` or
the `Deploy Dev` workflow be dispatched. `values-dev.yaml` enables the flag for
the hosted dev environment; base `values.yaml` leaves it off.

## Deploy and force an ESO sync

After the Helm upgrade has added the gated `sentry-dsn` mapping, request an
immediate External Secrets Operator reconciliation:

```bash
kubectl annotate externalsecret api-keys -n commonly-dev \
  force-sync="$(date +%s)" --overwrite
kubectl wait --for=condition=Ready externalsecret/api-keys \
  -n commonly-dev --timeout=120s
```

Confirm the backend deployment has the variable names without printing their
values, then verify a deliberately generated test error in each Sentry project:

```bash
kubectl get deployment backend -n commonly-dev \
  -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}{"\n"}{end}' \
  | grep '^SENTRY_'
```

Backend events use the backend image tag as `release`; frontend events use the
short image SHA passed as `REACT_APP_VERSION`. The event environment comes from
the corresponding Node build/runtime environment.

## Configure a spike alert

In each Sentry project, create an issue/event-frequency alert that fires when
the total event count exceeds the chosen threshold in one hour. Route the alert
to the engineering email target. Start with a conservative threshold, observe
normal traffic for a week, then tune it so a real error loop pages while a small
release-time burst does not.

## Privacy stance

Both SDKs are configured with `sendDefaultPii: false`. Immediately before an
event is sent, Commonly removes the top-level user object and all request
headers and cookies. Performance traces are sampled at zero, and the frontend
does not enable Session Replay.

**Backend.** Nothing an error says reaches Sentry; see *What the backend sends*.

**Frontend.** What a frontend event carries is listed under *Frontend events* below. Do not
put tokens, message bodies, email addresses, or other sensitive user content in
exception messages. Review the first real events in both projects before
expanding access or retention.

## What the backend sends

Two kinds of event, both built by `backend/services/serverErrorReport.ts`.
`beforeSend` there is an allowlist: a field not named in it does not leave.

| Event | Carries | Comes from |
|---|---|---|
| Handled 5xx | title `5xx 500 GET /api/pods/:id/focus`, tags `source: handled_5xx`, `method`, `route`, `status`, a fingerprint of those | a `finish` middleware, for any response of 500 or above, including a route's own `res.status(500)` |
| Unhandled exception | fixed text `Unhandled request error`, the exception type, stack frames | Sentry's Express handler, and uncaught exceptions |

Both also carry `release`, `environment`, `server_name` and the SDK's own
fields. A request whose error Sentry's handler captured (`res.sentry` is set) is
not reported again by the middleware. The middleware skips `/api/health` and
everything under it, in any letter case. That covers handled responses only: an
exception a health handler throws still reaches Sentry's handler as an
unhandled exception, uncapped, like any other route's.

`beforeSend` sees error events only, so the client's `beforeEnvelope` hook
drops every envelope item that is not an `event` or a `client_report`. A cron
check-in (which carries its monitor slug verbatim), a session, a span and an
attachment do not leave.

**Why so little.** OAuth vendor and secret-storage errors can embed token
values in their message, stack or context (#2555). So no event text, URL, query
string, header, body, user id, breadcrumb, tag, context or source line leaves.

- **Route:** the matched pattern plus `req.baseUrl`. `baseUrl` is URL text, so
  each of its segments must be a plain lowercase word; otherwise it reads `:id`
  (a number, hex id or uuid) or `:value`. A segment equal to any param value
  the routing assigned reads `:value` as well, so `sk_live_x` under a
  `/:grantId` mount does not pass as a word. A request no route matched reads
  `unmatched`, never its URL. A failure in a `router.use` middleware reads
  `unmatched` too, because no route had matched yet.
- **Frames:** only `filename`, `function`, `lineno`, `colno`, `in_app`, and
  `abs_path` under the app. `vars` and source lines go, including the ones the
  SDK's context-lines integration adds. A filename that is not a plain path (a
  `data:` URL, a query string) and a function name that is not a plain dotted
  name (eval text, a generated name) lose that field. "Generated" is a shape
  check, 5 or more digits in a name of 16 or more, or over 64 characters: a
  short all-letter name from `new Function` passes.
- **Exception type:** kept only as a plain identifier, otherwise `Error`.

**How the safe title stays safe.** The middleware captures an empty event and
hands a frozen record to `beforeSend` in the SDK hint; `beforeSend` writes the
title from the record, and only if the record is in a WeakSet private to the
module. It never reads a title, tag or fingerprint from an event, so an event
that looks like a report is stripped like any other. Don't add a second way in.

**Caps.** One report per fingerprint per 15 minutes, 8 per fingerprint per UTC
day, and 60 per process per UTC day, counted before send (at most 1,800 a month
from one backend pod, against the free tier's 5,000). The per-fingerprint cap is
what keeps one route failing all day from spending the 60 by mid-afternoon and
silencing every other route's first report. A 15-minute window open at UTC
midnight stays open into the new day. State is in memory, so a restart starts
over and each replica has its own cap. Unhandled exceptions are not capped. The
dedupe map only grows when a report spends the daily cap, so it stays at 60
entries, plus at most 60 windows carried over midnight.

**Reading an event.** Filter `source:handled_5xx` for handled responses. The
event count is not the failure count: a report means "at least one in this
window". To count, use the access log, which has one JSON line per request with
`route` and `status` (`middleware/accessLog.ts`). For the cause, the route tells
you where to look in the pod log; handled events have no stack. Frames point at
compiled JS under `dist`, not the `.ts` source.

## Frontend events

A frontend event says where an error happened, not what it said. The rules live
in `beforeSend` and `beforeBreadcrumb` in `frontend/src/sentry.ts`, and
`frontend/src/sentry.envelope.test.ts` runs the real SDK to check the envelope
that would leave the browser.

**Sources.** Uncaught errors and unhandled rejections arrive through the SDK's
global handlers. Crashes caught by `AppErrorBoundary` and `V2ErrorBoundary`
arrive through `reportBoundaryError` (`frontend/src/sentryReport.ts`), tagged
`boundary: app` or `boundary: v2`. That helper loads the Sentry chunk on first
use, does nothing without a DSN, never throws, and sends a given message at
most once per boundary per browser session and at most five reports per page
load. The boundary's on-screen fallback still shows the message locally.

**An event keeps:**

- the exception type when it is a built-in (`Error`, `TypeError`,
  `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`,
  `AggregateError`), otherwise `Error`; one entry per error in a `cause` or
  `AggregateError` chain;
- a fixed exception value, `Error text is not sent`;
- stack frames, reduced to file, function, module, line, column and `in_app`;
- mechanism fields that describe how the error was caught (type, handled,
  synthetic, source, and the chain ids);
- the `boundary` tag, release, environment, the React component stack, the
  trace ids and the browser's locale and time zone;
- breadcrumbs, reduced to type, category, level, timestamp, and for request
  and navigation breadcrumbs method, status code and URL; and
- the page URL and request method.

**Every URL** in an event (the page, breadcrumbs, frame files) is reduced to
origin and path, with no userinfo, query string or fragment. The path segment
after `/invite/`, `/invites/`, `/users/`, `/profile/` and `/uploads/`, and the
token segment of the email unsubscribe and open links, is replaced with
`[masked]`. `data:` and `blob:` URLs keep only their scheme.

**An event drops:** the event message, `logentry`, `extra` (including a thrown
object's serialized copy), `transaction`, `fingerprint`, `user`, other tags and
contexts, request headers, cookies, body and query string, breadcrumb messages
(console text and clicked-element selectors), console arguments, and frame
variables and source context lines.

## Self-hosted behavior and rollback

With the default `errorTracking.enabled: false` and no
`REACT_APP_SENTRY_DSN` build argument:

- the backend does not call `Sentry.init` or attach its Express error handler;
- the frontend build removes the guarded dynamic import, so the browser never
  loads a Sentry chunk; and
- no Sentry SDK network requests are made.

To disable hosted error tracking, set the Helm flag to `false`, rebuild the
frontend without `REACT_APP_SENTRY_DSN`, and redeploy. Removing only the backend
DSN disables backend initialization, but a previously built frontend image
continues to contain its compile-time DSN until it is rebuilt.
