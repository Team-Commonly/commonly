# UI validation

How to get a v2 screen into a state worth screenshotting, and what to check once it is.

## Step 0: seed staging (TASK-697)

Run the staging seed before any `dev:live` or staging screenshot pass. An empty
pod hides every layout bug that only shows with real-shaped data: long agent
messages, a run of system lines, a card, a thread, a full board.

One command, safe to re-run. A second run writes nothing:

```bash
node dist/scripts/staging-seed.js --target=commonly-staging [--cred-out=<path>] [--rotate]
```

(`npm run seed:staging -- --target=commonly-staging` inside `backend/` is the same thing.)

What it writes, every row under a fixed id:

- Pod **D215 sample**: invite-only, not publicly readable, not listed. Four agents
  (Wren, Forge, Marlow, Tamsin, each with an `AgentInstallation` and a role line
  in `botMetadata.description`) and the humans Maya Chen and Jon Park. There is no
  stored tint field. v2 derives an agent's avatar ground from its `agentName:instanceId`
  seed, so the four distinct identities produce the spread of tints.
- Board: 13 rows, at least 3 in each of pending, claimed, blocked and done, all
  assigned. TASK-008 depends on TASK-004, and TASK-011 is done with a PR link.
- Chat, in PostgreSQL: three agent messages over 1,500 characters each, a run of
  four `task-claimed` system lines, a rev-1 `commonly.ui` card (checked by
  `services/uiCardValidation` before it is written), and a four-reply thread.
- Memory for Wren and Marlow, written once and never overwritten by later runs.
- Claimed rows carry no lease timestamps, so they read as held. A past `claimedAt`
  would lapse within one sweep and the rows would drop back to pending.
- Members are added, never replaced, so people who joined through the UI stay.
- The seat test account **`d215-seat`**: a non-admin member of the pod, and the
  installer of the four agents, so its owner views list them. It has one
  connected hosted connector (Linear, with no credential, so any call asks to
  reconnect) and one connector that is available but not connected (Notion).

### The seat credential

The seat password is generated only when the account is first created, or when you
pass `--rotate`. It is written only to the `--cred-out` file, mode 0600, and never to
stdout or logs. Without `--rotate`, a re-run leaves the password and the file untouched.
If you lose the file, re-run with `--rotate`. That also ends the seat's open sessions.

Sign in with the `email` from the credentials file (login is by email, not username)
and its `password`. The file is written before the database. So if a `--rotate`
fails on the database write, the file holds a password the account never got, and
the fix is to rotate again.

- **Where the operator keeps it:** `~/.commonly/credentials/staging-seat-test.json`
  on the operator's machine (directory 0700). Never inside a repo: the script refuses
  a `--cred-out` with a `.git` anywhere above it.
- That same path, under the process's home, is the script's default `--cred-out`.
  In the cluster, write to `/tmp` instead and copy the file out (see below).

### Running it on staging

Staging has no ops-runner, so exec into the staging backend in namespace
`commonly-staging`. The image already holds the compiled script at
`dist/scripts/staging-seed.js`, plus the staging `MONGO_URI` and `PG_*`. Pin one pod,
so that all three steps reach the same filesystem:

```bash
POD=$(kubectl get pod -n commonly-staging -o name | grep '^pod/backend-' | grep -v worker | head -1)

kubectl exec -n commonly-staging "$POD" -- \
  node dist/scripts/staging-seed.js --target=commonly-staging --cred-out=/tmp/staging-seat-test.json

# Only when the run says "credentials written" (first run, or --rotate):
mkdir -p -m 700 ~/.commonly/credentials
(umask 077; kubectl exec -n commonly-staging "$POD" -- cat /tmp/staging-seat-test.json \
  > ~/.commonly/credentials/staging-seat-test.json)
kubectl exec -n commonly-staging "$POD" -- rm -f /tmp/staging-seat-test.json
```

The script refuses before it writes anything unless all of these say staging
(`backend/scripts/staging-seed/guard.ts`):

- `--target=commonly-staging` was passed.
- The pod's own namespace (the service-account namespace file, else `POD_NAMESPACE`)
  is `commonly-staging`.
- Every `MONGO_URI` host is the in-cluster `mongodb` Service. `mongodb+srv` (Atlas)
  is refused.
- `PG_DATABASE` is `commonly_staging`. A `PG_HOST` that names another namespace's
  Service is refused.

Run against prod's namespace, Atlas or `defaultdb`, it exits 1 with the reason.

**Caveat:** if staging restricts sign-in (`AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS`),
the seat's address `d215-seat@seed.staging.commonly.me` must be allowed, or the login is refused.

## Then: check the screens

- Layout, overflow and scroll need a real browser (CLAUDE.md design rule 9).
  Sign in as `d215-seat`, open the D215 sample pod, and check at 1440 and 390 wide,
  in light and in dark.
- Chat should show the long messages wrapping, the four claimed lines in a row,
  the card rendered (not its fallback text), and the thread under Marlow's review.
- Board should show every column populated, the blocked row's dependency, and the
  done row's PR link.
- Connectors should show Linear as connected and Notion as available.
