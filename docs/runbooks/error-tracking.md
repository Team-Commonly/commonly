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

Error messages, stack traces, release/environment values, request URL and
method, and default browser breadcrumbs can still be reported. Do not put
tokens, message bodies, email addresses, or other sensitive user content in
exception messages. Review the first real events in both projects before
expanding access or retention.

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
