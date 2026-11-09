# Staging email sink: reading a walker's mail

Staging limits sign-up to team domains (`AUTH_ALLOWED_*`). An allowlisted address
is not proof of a mailbox, so register refuses email sign-up with
`503 INSTANCE_VERIFICATION_UNAVAILABLE` unless email delivery is configured
(`authController.register`). Staging has no real delivery, so until the sink
existed, no walk could reach the email leg of sign-up.

`email.sink.enabled` (on in `values-staging.yaml` only) deploys `email-sink`, an
in-cluster stand-in for SMTP2GO (`backend/services/stagingEmailSink.ts`). The
backend and its worker send every mail there: verification, password reset,
digest and needs-you. Nothing leaves the cluster.

## Turning it on

The read token is synced by its own ExternalSecret from the store key
`<keyPrefix>email-sink-read-token` (`commonly-staging-email-sink-read-token`
for staging). Create that key with a random value before enabling the sink,
or the sink pod waits on a Secret that never arrives:

```bash
openssl rand -hex 24 | tr -d '\n' | \
  gcloud secrets create commonly-staging-email-sink-read-token --data-file=- --project="$PROJECT"
```

Without external secrets, create the `email-sink` Secret (key `read-token`) in
the release namespace by hand.

## Walking email sign-up on staging

1. Register at `https://staging.commonly.me` with a fresh address on an allowed
   domain, e.g. `walk-<date>-1@seed.staging.commonly.me`. Addresses on
   `ops.commonly.invalid` are reserved: `emailService` never sends to them, so
   they never reach the sink either.
2. Read that address's mail back:

   ```bash
   NS=commonly-staging
   TOKEN=$(kubectl get secret email-sink -n $NS -o jsonpath='{.data.read-token}' | base64 -d)
   kubectl port-forward -n $NS svc/email-sink 18025:80 >/dev/null 2>&1 &
   PF=$!; sleep 2
   curl -s -H "Authorization: Bearer $TOKEN" \
     "http://localhost:18025/inbox?to=walk-<date>-1@seed.staging.commonly.me" \
     | jq -r '.messages[] | "\(.at) \(.subject)\n  \(.links | join("\n  "))"'
   kill $PF; unset TOKEN
   ```

   Messages come back newest first, and each lists the links found in its text
   and HTML. Open the verification link to finish the walk.

## What to expect

- **The inbox lives in memory.** One replica on the spot lane, newest 500
  messages kept. A restart or a spot reclamation empties it, so read a link
  soon after you trigger the mail.
- **Reading needs the token**, because the inbox holds verification and reset
  links for every staging account, team members' included. Sending accepts any
  `api_key`, so the sink caps what it keeps: a body over 256 KB is refused with
  413, each stored text or HTML part is cut at 64 KB, at most 32 connections
  are open at once, and a request unfinished after 15 s is dropped.
- **The chart refuses the sink** when `email.enabled` (real SMTP2GO) is also on,
  and wherever `backend.env.frontendUrl` is `https://commonly.me`, so prod mail
  can never be captured by mistake.
- `GET /healthz` reports `{ ok, stored }`, the count of messages held.
