# Connector credentials setup: GitHub App, Slack, Discord

**Use this when** you are standing up (or rotating) the credentials behind a
connector that the backend reads from the `api-keys` ExternalSecret: the
GitHub App that the room-grant broker executes as, the Slack app behind the
installable Slack connector, or the Discord public key behind webhook
verification.

**Source.** The Connectors v2 pod record for 2026-09-17/18 (the night the
three landed on dev) and the code on `main` at `cda51208`. Chart history:
`#1716` (GitHub App mapping), `#1725` (Slack OAuth flip), `#1685` (Discord
public key). This page carries **no secret values, no project or cluster
identifiers, and no hostname other than `api.commonly.me`**. Anything that
needs one comes from the operator's private notes, never from this file.

**Where the pieces live on main**

| Piece | Path |
|---|---|
| Secret Manager → k8s secret mapping | `k8s/helm/commonly/templates/secrets/api-keys.yaml` |
| k8s secret → backend env | `k8s/helm/commonly/templates/core/backend-deployment.yaml` (every ref below is `optional: true`) |
| Slack gate flag | `k8s/helm/commonly/values.yaml` (`slack.oauth.enabled: false`) / `values-dev.yaml` (`true`) |
| GitHub App reader | `backend/services/githubAppService.ts`, `backend/services/installable/toolInstallables.ts` |
| Slack readers | `backend/services/slackOAuthService.ts`, `backend/routes/webhooks/slack.ts`, `backend/services/connectorSecrets.ts` |
| Discord reader | `backend/routes/webhooks/discord.ts` → `backend/services/webhookVerificationService.ts` |

---

## 0. Two rules that apply to every connector

### 0.1 One missing remoteRef freezes the whole `api-keys` ExternalSecret

ESO (External Secrets Operator) reconciles `api-keys` as one resource. When
**any** `remoteRef` in it names a Secret Manager secret that does not exist,
the resource goes `SecretSyncedError` and **every other key in the bundle
stops refreshing** until the missing one exists. The chart comments above the
GitHub App and Discord blocks in `api-keys.yaml` say exactly this, and Slack's
five entries are wrapped in `{{- if .Values.slack.oauth.enabled }}` for the
same reason: the mapping must not render until the values exist.

So the order is always:

1. Create every Secret Manager value the chart change will reference.
2. Merge the chart change (mapping and/or values flip).
3. Deploy.

The backend side is the safe half: every env ref is `secretKeyRef … optional:
true`, so a missing value fails the ESO sync, not the pod start. That is a
comfort only if you know the sync failed. After a deploy, check the resource
is `Ready` and its entry count moved by the number you expected (the pod
record measured `55` after #1716 + #1685 and `59 → 64` for the Slack flip).

ESO owns `api-keys`; a direct `kubectl patch` is overwritten on the next
hourly sync. To pull a new value in immediately after creating it in Secret
Manager:

```bash
kubectl annotate externalsecret api-keys force-sync=$(date +%s) -n <namespace> --overwrite
```

### 0.2 Take the cutover from the pod's startTime, not the workflow tick

`Deploy Dev` going green is not the moment the new env is live. Kubernetes
serves from the **old** pod through the rolling update, so any check you run
against the workflow's completion time can land on a pod that never had the
new secret. Take the cutover from the new pod:

```bash
kubectl get pod -n <namespace> -l app=backend -o jsonpath='{.items[*].status.startTime}'
```

and run every post-deploy check **inside that pod**, by presence and byte
length only. Never print a value into the pod record:

```bash
kubectl exec -n <namespace> deploy/backend -- node -e \
  'for (const k of process.argv.slice(1)) console.log(k, process.env[k] ? process.env[k].length + " B" : "MISSING")' \
  GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY DISCORD_PUBLIC_KEY SLACK_SIGNING_SECRET CONNECTOR_SECRET_KEYS
```

(AX audit entries 34 and 35 and the "verify a ship at the CONSUMER" rule in
`CLAUDE.md` are the same rule in general form.)

---

## 1. GitHub App (room-grant broker)

### What reads it

`githubAppService.ts` mints an RS256 app JWT from `GITHUB_APP_ID` +
`GITHUB_APP_PRIVATE_KEY`, exchanges it at
`POST /app/installations/:id/access_tokens` for a one-hour installation token,
and runs the broker's operations with it. `toolInstallables.ts` reports the
GitHub tool Installable as available when **`GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` are both set** and nothing else. The third variable,
`GITHUB_APP_INSTALLATION_ID_COMMONLY`, is the legacy deployment-default
installation; `isConfigured()` still checks it, but the broker never falls
back to it. It executes as the Connection row's **own** installation
(`config.installationId`), so a Connection can only ever reach the repos its
installation covers.

### Permission set

Derived from the eight broker tools in `toolBrokerService.ts` (`list_issues`,
`create_issue`, `get_issue`, `comment_on_issue`, `close_issue`,
`get_pull_request`, `list_pull_request_files`, `merge_pull_request`) and the
service methods behind them (`getPullDiff`, `createPullReview`):

| Permission | Level | Why |
|---|---|---|
| Issues | Read & write | list / create / comment / close |
| Pull requests | Read & write | get / files / diff / review / merge |
| Contents | Read & write | merge writes to the default branch |
| Metadata | Read | mandatory for any App |

Nothing else. In particular **no Webhook**: the App is an outbound credential
for the broker, it does not receive events. Set "Webhook → Active" **off**
when creating it, so GitHub does not require a webhook URL and secret you
would then have to host.

### Install on the target repo only

Install the App with "Only select repositories" and pick the repository the
broker should be able to act on. The pod record established that a Connection
created from this installation reaches exactly that repo set and nothing
else, so **the install scope is the outer boundary of every grant minted on
it**. A wider install widens what an approved call can touch. If a run needs
a sandbox repo, widen the installation to that repo first; do not create a
second App.

### The three Secret Manager names

`api-keys.yaml` maps, in the block headed "GitHub App credentials for the
room-grant broker":

| Secret Manager name | k8s key / env |
|---|---|
| `commonly-dev-github-app-id` | `GITHUB_APP_ID` |
| `commonly-dev-github-app-private-key` | `GITHUB_APP_PRIVATE_KEY` |
| `commonly-dev-github-app-installation-id` | `GITHUB_APP_INSTALLATION_ID_COMMONLY` |

Write the private key with `--data-file=<path-to.pem>` so the stored bytes
equal the file bytes, newlines included. The post-deploy presence check should
report the PEM at its file length (a fresh GitHub App key is around 1.7 KB)
and `crypto.createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY)` must parse
it inside the pod. A key pasted through a shell that collapsed newlines will
have the right presence and the wrong parse.

### Verify out of band before the chart merges

With the PEM and the app id on the operator machine (never in the pod
record):

1. Mint the app JWT (`iat` now-60s, `exp` now+600s, `iss` = app id, RS256).
2. `GET https://api.github.com/app` with `Authorization: Bearer <jwt>` → the App.
3. `POST https://api.github.com/app/installations/<id>/access_tokens` → `201`
   whose `permissions` show exactly the four above.
4. `GET https://api.github.com/installation/repositories` with the token →
   only the target repo.

### The chart PR shape (#1716)

Two files: the mapping block in `api-keys.yaml` with the ESO
warning comment above it, and three `optional: true` env refs in the backend
deployment. Verify with `helm lint k8s/helm/commonly` and `helm template test
k8s/helm/commonly --set externalSecrets.enabled=true`. The PR was **held
open** until the three Secret Manager values existed, and only then merged.
That is the pattern: a mapping PR is a promise the values exist, so it merges
after they do, never before.

### Post-deploy acceptance

Inside the new pod (§0.2): the three variables present; PEM parses; the
GitHub tool's readiness reports `{ "available": true }`. Then, as an admin,
`POST /api/integrations/github-app` with `{ installationId, owner, repo }`
creates the Connection row (type `github-app`, scope `user`, owner = the
admin). A grant on that Connection returns `201`, and a read call (for
example `github.list_issues`) reaches the repo without parking on a
confirmation card. Writes with `confirm` park; that is by design.

---

## 2. Slack (installable connector)

### 2.1 What reads it

| Env | Reader | Purpose |
|---|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | `slackOAuthService.ts` | OAuth v2 install flow; redirect `…/api/webhooks/slack/oauth/callback`; bot scopes `im:history, im:write, chat:write, users:read, commands` |
| `SLACK_SIGNING_SECRET` | `routes/webhooks/slack.ts` | the `signed` middleware in front of `POST /api/webhooks/slack/events` and `/commands` |
| `CONNECTOR_SECRET_KEYS`, `CONNECTOR_SECRET_ACTIVE_KEY` | `connectorSecrets.ts` | envelope-encryption key ring for connector credentials at rest (ADR-025 finding 5) |

The legacy ingest-only integration (`docs/slack/README.md`, `POST
/api/webhooks/slack/:integrationId`, `slack-bot-token`) keeps working
untouched; it reads a per-integration signing secret from its own row and
falls back to the same env.

### 2.2 Reuse the existing app

One Slack app serves both the legacy ingest integration and the installable
connector. Do **not** create a second app for the OAuth flow: add the OAuth
redirect, the bot scopes, the slash command and (later) the events
subscription to the app that already exists. Its existing bot token stays
where it is.

### 2.3 Change the app through the manifest API

The app configuration UI works, but the manifest API is reproducible and
leaves a record. It needs an **App Configuration Token** from
"Your App Configuration Tokens" on the Slack apps page. The token is valid
for **12 hours** and comes with a refresh token; get it at the start of the
session and expect to refresh if the work spans a break. The sequence is
export → merge → validate → update:

```bash
CFG=<app-configuration-token>   # 12-hour token, never committed
APP=<app-id>

# 1. export the manifest the app has today
curl -s -X POST https://slack.com/api/apps.manifest.export \
  -H "Authorization: Bearer $CFG" -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP\"}" | jq '.manifest' > manifest.json

# 2. merge the additions into manifest.json (see below), by hand or with jq

# 3. validate before touching the app
curl -s -X POST https://slack.com/api/apps.manifest.validate \
  -H "Authorization: Bearer $CFG" -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP\",\"manifest\":$(cat manifest.json)}" | jq '.ok,.errors'

# 4. apply
curl -s -X POST https://slack.com/api/apps.manifest.update \
  -H "Authorization: Bearer $CFG" -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP\",\"manifest\":$(cat manifest.json)}" | jq '.ok,.errors'
```

What to merge in, matched to what the code asks for:

- `oauth_config.redirect_urls`: `https://api.commonly.me/api/webhooks/slack/oauth/callback`
  (must equal what `slackOAuthService.ts` sends as `redirect_uri`, or
  `SLACK_OAUTH_REDIRECT_URI` if you override it).
- `oauth_config.scopes.bot`: the five scopes above, added to whatever the
  legacy integration already has.
- `features.slash_commands`: `/commonly` → `https://api.commonly.me/api/webhooks/slack/commands`.
- `settings.event_subscriptions.request_url` → **not yet**, see §2.6.

### 2.4 The five Secret Manager names (behind `slack.oauth.enabled`)

| Secret Manager name | k8s key / env | Value shape |
|---|---|---|
| `commonly-dev-slack-client-id` | `SLACK_CLIENT_ID` | from the app's Basic Information |
| `commonly-dev-slack-client-secret` | `SLACK_CLIENT_SECRET` | from Basic Information |
| `commonly-dev-slack-signing-secret` | `SLACK_SIGNING_SECRET` | from Basic Information |
| `commonly-dev-connector-secret-keys` | `CONNECTOR_SECRET_KEYS` | `k1:<base64 of 32 random bytes>` (comma-separated `keyId:base64` list) |
| `commonly-dev-connector-secret-active-key` | `CONNECTOR_SECRET_ACTIVE_KEY` | `k1` (must name a key in the ring) |

The key-ring format is the trap: `connectorSecrets.ts` parses
`CONNECTOR_SECRET_KEYS` as comma-separated `keyId:base64Key` and refuses a
key that does not decode to **exactly 32 bytes**, a duplicate id, or an active
id absent from the ring. A raw base64 value with no `k1:` prefix is rejected
at first use, not at boot. Generate and verify without ever printing the key:

```bash
KEY="k1:$(openssl rand -base64 32)"          # 47 bytes as stored
printf '%s' "$KEY" | cut -d: -f2- | base64 -d | wc -c   # must print 32
```

All five must exist in Secret Manager **before** the values flip merges,
because the flip is what makes `api-keys.yaml` render the five remoteRefs
(§0.1).

### 2.5 The chart PR shape (#1725)

One file, four lines: append to `values-dev.yaml`

```yaml
slack:
  oauth:
    enabled: true
```

and nothing else. `values.yaml` keeps the default `false` with the comment
explaining the gate. Pre-check the render before asking for the gate: the
`api-keys` ExternalSecret should gain exactly five entries, and the names
should be the five above. `helm lint` passes.

### 2.6 Why the events `request_url` waits for the deploy

`POST /api/webhooks/slack/events` sits **behind the `signed` middleware**. When
you save a Request URL, Slack immediately posts a `url_verification` challenge
to it and only accepts the URL if the challenge echoes back. The route answers
the challenge **after** the signature check, and the signature check needs
`SLACK_SIGNING_SECRET` in the running pod. Set the URL before the secret is
deployed and the challenge gets `401 Invalid Slack signature`, Slack refuses
to save the URL, and the failure reads like a wrong URL. The order is:

1. Five Secret Manager values exist (§2.4).
2. `slack.oauth.enabled: true` merges (#1725 shape).
3. `Deploy Dev`; take the cutover from the new pod's `startTime` (§0.2) and
   confirm `SLACK_SIGNING_SECRET` is present in it.
4. Only now set `settings.event_subscriptions.request_url` to
   `https://api.commonly.me/api/webhooks/slack/events` (manifest update or
   UI); the challenge passes.
5. Bot events to subscribe to are the ones the installable connector handles
   in `routes/webhooks/slack.ts` (`message.im` for DMs); add more only when a
   handler exists.

### 2.7 Switch socket mode off after the deploy

If the app was previously run in socket mode (an app-level `xapp-` token,
events delivered over a websocket), turn it off once the HTTP `request_url`
is verified: `settings.socket_mode_enabled: false` in the manifest. Socket
mode and the HTTP Events API are alternative delivery paths for the same
subscriptions; while socket mode is on, Slack delivers events only over the
socket and disregards the Request URL, so the HTTP endpoint never sees them. Public distribution (so workspaces other than ours can
install) is the step after that, and is a Slack review, not a code change.

### 2.8 Post-deploy acceptance

Inside the new pod: the five variables present; `connectorSecrets` parses
(one ring entry, 32 bytes, active id in the ring; print ok/fail only). Then
the OAuth install from the Connectors page round-trips through the callback
and lands a connector row, and `/commonly` in Slack reaches `/commands`
signed.

---

## 3. Discord (webhook Ed25519 verification)

### What reads it

`routes/webhooks/discord.ts` verifies every delivery to
`POST /api/webhooks/discord` with `verifyDiscordSignature` (Ed25519 over
`X-Signature-Timestamp` + raw body, key from `DISCORD_PUBLIC_KEY` as 64 hex
characters). It is **fail-closed**: an absent key rejects every request with
`401`, and only `DISCORD_WEBHOOK_ALLOW_UNVERIFIED=true` (never on a shared
instance) bypasses it. `routes/discord.ts` uses the same key for slash-command
interactions.

### Read the key with the bot's own token

The value is the app's **public key** ("General Information" → "Public Key" in
the developer portal; `docs/discord/DISCORD_APP_SETUP.md` step 3). You do not
need portal access to fetch it: the bot token already in the backend pod can
read it from Discord's API, so run this **inside the pod** and copy the
`verify_key` field:

```bash
kubectl exec -n <namespace> deploy/backend -- sh -c \
  'curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/applications/@me' \
  | jq -r '.verify_key'
```

It is a public value, so printing it is fine. It still goes through Secret
Manager rather than a ConfigMap so that it rides the same mapping path and
rotation story as every other key in the bundle.

### One Secret Manager name and the chart PR shape (#1685)

| Secret Manager name | k8s key / env |
|---|---|
| `commonly-dev-discord-public-key` | `DISCORD_PUBLIC_KEY` |

Two files: the mapping in `api-keys.yaml` under the "Discord webhook
verification" comment, and one `optional: true` env ref in the backend
deployment. Same hold rule as §1: the PR merged only after the Secret Manager
value existed, because deploying the fail-closed ingress before the key is
live turns every Discord delivery into a `401`.

Existing Discord docs: `docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md`
("Environment Variables") lists `DISCORD_PUBLIC_KEY` beside the bot token and
client credentials, and `docs/discord/DISCORD_APP_SETUP.md` (steps 3 and 5)
walks the portal side.

---

## 4. One-page order of operations

For any connector credential that lands in `api-keys`:

1. Create the Secret Manager value(s). Verify format locally by length or
   parse, never by printing (§1 PEM bytes, §2 `k1:` ring, §3 64 hex chars).
2. Open the chart PR (mapping block with the ESO comment + `optional: true`
   env ref, or the values flip). `helm lint`; render and count the delta.
3. Merge only after step 1 is confirmed for **every** name the PR references
   (§0.1).
4. `Deploy Dev`. Cutover = new pod `startTime` (§0.2).
5. Inside the new pod: presence + length, parse checks, reader readiness.
6. Only then the provider-side step that depends on the deployed secret
   (Slack `request_url`; GitHub Connection create; Discord webhook enable).
7. Post outcomes to the pod record by name and length, never by value.
8. Rotating the ring is not a stand-up: the order is §5 — append, flip the
   active id, rewrap to zero, then drop the old key.

---

## 5. Rotating the connector-secret key ring

**Use this when** the value behind `commonly-dev-connector-secret-keys` has to
change: a scheduled rotation, or a key you believe was exposed. §2.4 has the
format and the refusal modes; this section is the **order**, which is the part
that loses data.

Every `ConnectorSecret` row is encrypted under the key id it was written with,
and it is decrypted with **the ring as it stands**. So the ring value is
**appended to, never replaced**: replace `k1:…` with `k2:…` and `k1` leaves the
ring while rows still name it, so those rows stop decrypting and whatever reads
one fails at use rather than at boot. `CONNECTOR_SECRET_ACTIVE_KEY` is the same
trap one step later — it must name a key present in the ring or `parseKeyRing`
refuses (§2.4), which is a failing connector instead of a failing start.

Rotation is four steps in this order. It is the order the rewrap script's own
header states, which is why that header exists:

1. **Append the new key.** Generate it as in §2.4 and set
   `commonly-dev-connector-secret-keys` to `k1:<old>,k2:<new>`, leaving
   `commonly-dev-connector-secret-active-key` on `k1`. Force-sync (§0.1) or wait
   out the 1h ESO refresh, then confirm from the pod that the ring names two ids
   — by count, never by value.
2. **Point the active key at the new id.** Set
   `commonly-dev-connector-secret-active-key` to `k2` and force-sync again. New
   writes encrypt under `k2`; existing rows still decrypt, because `k1` is still
   in the ring. Nothing has been rewritten yet.

   Before going on, confirm from the pod that the active id is now `k2`:

   ```bash
   kubectl exec -n <namespace> deploy/backend -- printenv CONNECTOR_SECRET_ACTIVE_KEY
   ```

   Until that reads `k2`, step 3 has nothing to do — and reports success for that
   reason. (`CONNECTOR_SECRET_ACTIVE_KEY` is the key **id**, a label;
   `CONNECTOR_SECRET_KEYS` holds the ring and is never printed, here or anywhere
   else on this page.)
3. **Rewrap until it reports zero.** In the backend pod, which carries
   `MONGO_URI` and the ring (the script exits if either is missing):

   ```bash
   # dry run: lists the rows still under a non-active key
   kubectl exec -n <namespace> deploy/backend -- node dist/scripts/rewrap-connector-secrets.js
   # re-encrypt them under the active key
   kubectl exec -n <namespace> deploy/backend -- node dist/scripts/rewrap-connector-secrets.js --apply
   ```

   The dry run's count is the **pre-state** — note it. The acceptance check is
   the apply line, and it is **two numbers**: `rewrapped <the dry-run count>;
   remaining under non-active keys: 0`. `remaining: 0` on its own does not
   distinguish a completed rewrap from one that never started — it is satisfied
   by "everything was rewrapped" and by "nothing needed it", and the second one
   is the disaster: the operator goes on to step 4 and drops `k1` while the rows
   still name it. A `rewrapped 0` against a non-zero dry-run count means the pod
   is still on the old active id; go back to step 2.

   The dry run is also the weaker of the two instruments. It selects on `keyId`
   and never decrypts, so a row whose key has already left the ring still reads
   as merely "needing rewrap" — the reassuring output is not evidence that the
   old key is still present. The loss surfaces only when `--apply` calls
   `rewrap()`, which decrypts before it writes (`getKey` throws
   `ConnectorSecretKeyMissing` first): fail-safe, nothing is written, but that is
   also why step 1 confirms the ring names both ids.

   Re-running is safe: `rewrap()` returns early on a row already under
   the active key, and compare-and-sets every rewrite it does make.
4. **Only now drop the old key.** Remove `k1` from
   `commonly-dev-connector-secret-keys` and force-sync. Dropping it at step 1 or
   2 instead is the failure this section exists to prevent.

Two properties of this surface are worth knowing before you start, because both
are quiet rather than loud:

- **`optional: true` on both env refs** (`templates/core/backend-deployment.yaml`)
  means a ring that disappears from the `api-keys` mapping still starts the pod —
  with no ring. §0.1's freeze does not cover this pair: it is a *missing*
  `remoteRef` that fails the sync, and an `optional: true` ref that resolves to
  nothing is simply absent. That is recoverable for as long as Secret Manager
  holds the value, and invisible until something reads a connector credential.
- **`api-keys` maps both at `latest`** (no `version:` on the `remoteRef`), so the
  one irreversible act is destroying the Secret Manager version carrying the old
  id: the key material is then gone, and rows naming it can never be rewrapped.
  Append, rewrap to zero, destroy — in that order.
