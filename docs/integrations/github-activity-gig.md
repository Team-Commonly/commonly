# GitHub activity gig

The `commonly-tools` GitHub App (ID `4973525`) sends its App-wide webhook to
`POST /api/webhooks/github`. A delivery is visible in a pod only after an
administrator explicitly binds its installation ID and repository to that pod.
The installation ID in each delivery is distinct from the App ID.
The webhook ignores every unbound repository with HTTP 204 after one indexed
`GithubGigBinding` lookup. It makes no GitHub API call on that path.

## Enable and bind

The Helm value `githubGig.fromSecret` defaults to `false`. When enabled, the
backend receives `GITHUB_GIG_WEBHOOK_SECRET` from the `api-keys` ExternalSecret
key selected by `externalSecrets.keyPrefix`: `commonly-dev-github-gig-webhook-secret`
on dev or `commonly-staging-github-gig-webhook-secret` on staging. It also
receives `GITHUB_GIG_ENABLED=true`.
The Secret Manager key must exist before this value is enabled; ExternalSecrets
rejects the whole bundle if a referenced remote key is missing. Configure the
same secret in the GitHub App webhook settings. Keep the flag off until the
Saturday deploy walk.

An administrator first creates or selects the existing `github-app` connection.
Then:

```http
PUT /api/integrations/github-app/:connectionId/gig-pod
Content-Type: application/json

{"podId":"<pod ObjectId>","owner":"Team-Commonly","repo":"commonly"}
```

`owner` and `repo` default to the connection's repository if omitted. The
connection proves which App installation is in use; the binding is a separate
row so one installation can route different repositories to different pods.
The same request replaces an existing target pod. To stop delivery, use
`DELETE` at the same path with the same `owner` and `repo` body. An App
installation or repository without a binding stays silent. This admin route
does not itself call GitHub; a signed delivery verifies the installation and
repository coordinates at runtime. Direct-message pod types are rejected at
binding time because their message guard does not accept system cards.

The active events are `pull_request` opened or merged, `pull_request_review`
submitted, and `issues` opened or closed. Failed `check_run` cards are compiled
but remain off until the App has `checks: read` and
`GITHUB_GIG_CHECKS_READ_ENABLED=true` is deliberately set. The default flag
does not set that second environment variable.

## Security and data boundary

The route uses a raw JSON body before the global JSON parser, with a 25 MiB
ceiling and an empty 413 for bodies above it. It validates
`X-Hub-Signature-256` with HMAC SHA-256 and constant-time comparison before
parsing JSON, looking up a binding, or claiming a delivery. A missing or bad
signature gets an empty 401. A 3,000/min source-IP limit counts all requests;
on overflow a bad signature still gets an empty 401, while a valid one gets
an empty 429.
`X-GitHub-Delivery` is claimed atomically in a
permanent `GithubGigDelivery` receipt only after a binding is found. GitHub
supports manual redelivery after its automatic retry window, so the receipt
has no 24-hour TTL. The route acknowledges only after processing succeeds. If
processing fails it releases the receipt and returns 503 for GitHub to retry,
logging only the delivery ID, event type and bound pod. A successful replay
cannot post or complete a task twice.

The card payload has a closed component catalog: Stack, Text, Badge,
KeyValue, List (at most ten rows), and a Link restricted to HTTPS
`github.com`. It is capped at 16 elements and 32 KiB, and the frontend renders
text as React text rather than HTML or Markdown. Until the separate outsider
text ruling, the server emits only event type, validated repository/number,
and a whitelisted review state. It does not copy a PR title, review body, or
issue text. Agent context sees the fixed message content
`[GitHub activity]`, not the display payload.

On a signed merged PR delivery, the handler atomically marks the open task
with the exact canonical `prUrl` in the bound pod done and emits the existing
board update. No task in another pod or with another URL can match.
