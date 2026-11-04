# Agent computer: Steel browser and waker

How the agent computer is deployed: one Steel browser per person, and the
waker the broker calls before it opens that browser. What the broker allows
an agent to do in the browser is in
[`docs/agents/agent-computer-staging.md`](../agents/agent-computer-staging.md).
Its first production user is Walker, the prod-walk expert (D244 pilot 2).

## What the chart renders

`templates/agent-computer/` renders nothing unless both of these hold:

- `backend.env.agentComputerEnabled` is `"true"`;
- `agentComputer.users` lists at least one Commonly user id (24 lowercase
  hex). A user id is a production record, so it goes in the private values
  overlay, never a committed values file. Any other shape fails the render.

For each user it renders:

- `steel-{userId}`: a Deployment, a ClusterIP Service on `:3000`, and a
  `steel-{userId}-profile` disk, which helm keeps on uninstall.
  - The image is pinned by digest. Upstream publishes only `latest`, so a bump
    means resolving the new index digest and changing
    `agentComputer.steel.image.digest`.
  - The pod has no service-account token and no role.
  - The Deployment has no `replicas` field. The waker owns scale, and helm's
    three-way merge then leaves a live session alone on upgrade.
- **The Steel pod has three parts:**
  - `steel` runs with `HOST=127.0.0.1` and `PORT=3001`. Steel binds its API,
    and Chrome binds its debugging port, to that host. Neither takes
    credentials, so neither is reachable from outside the pod.
  - `gate` (`backend/services/agentComputerSteelGate.ts`, from the backend
    image) is the pod's only listener, on `:3000`.
    - Every request and WebSocket upgrade must carry
      `Authorization: Bearer <token>`. The token is the `agent-computer-steel`
      Secret, key `token`; the backend's broker reads it as
      `AGENT_COMPUTER_STEEL_TOKEN`. The gate strips the header before Steel.
    - `/healthz` is open and reports only whether Steel's `/v1/health`
      answers 200. It is the pod's readiness probe.
  - `clear-profile-lock`, an init container, deletes Chrome's `Singleton*`
    lock files. Steel clears only a lock its own hostname left, and every new
    pod has a new hostname. Recreate and the ReadWriteOnce disk mean the old
    pod is gone first.
- **Where the profile lives.** `CHROME_USER_DATA_DIR` is the disk's mount
  path, which is also Steel's `persist: true` path. Steel launches a default
  browser at startup, before any session exists, and that launch must use the
  disk too, or the sign-in is lost on the next restart.
- **CDP goes through Steel's own WebSocket proxy** on the API port. The
  bundled nginx on `:9223` stays off (`--no-nginx`): it forwards the caller's
  Host header, and Chrome answers `/json/version` only for an IP or
  `localhost` Host.
- **One `agent-computer-waker` Deployment and Service,** shared by all users.
  - The code is `backend/services/agentComputerWaker.ts`, run from the
    backend image.
  - Its Role is limited to `get` on the rendered `steel-*` Deployments and
    `get`/`patch` on their `scale`.
  - Its token is the `agent-computer-waker` Secret, key `token`.
- **Each token has its own ExternalSecret.** A missing key fails only that
  sync, never `api-keys`.

The browser holds a signed-in session. Under ADR-015 it stays off spot, so
`values-dev.yaml` pins both pods to the dev pool.

## Turning it on

1. Create two Secret Manager keys, each with a random value of 32 bytes or
   more:
   - `<keyPrefix>agent-computer-waker-token`
   - `<keyPrefix>agent-computer-steel-token`
2. Add the owner's user id to `agentComputer.users` in the private overlay.
3. Run `Deploy Dev`. Then set `agentComputer.steel.gate.imageTag` in the
   overlay to that deploy's backend tag. Every deploy moves the backend tag,
   and any change to the Steel pod template restarts the browser, so an
   unpinned gate drops a live session on each deploy.
4. The backend reads both tokens only at pod start (the secret refs are
   optional). If the backend pod started before the ExternalSecrets synced,
   restart it. `agentComputerEnabled()` stays false until the env holds both.
5. Give the computer tools to exactly one installation:
   - it must be a native install (`runtimeType: 'native'`), owned by the
     person whose id is in `users`;
   - `config.tools` lists the `computer_*` tools, `computer_request_takeover`
     included;
   - no other installation lists them.
6. Do the one-time sign-in through `computer_request_takeover`. The owner signs
   in by hand in the takeover UI, and the agent never types a password. The
   profile disk keeps that session across restarts.

## What keeps a page away from Steel

The gate token is a Secret in the namespace, so it is exactly as private as
the namespace's Secrets. Two workloads already read those Secrets (the backend
and ops-runner run as `agent-provisioner`), and both hold the token in their
env. A port-forward into the pod reaches Steel's loopback port directly.

Inside the pod, Steel's API (`:3001`) takes no credentials and answers any
origin. Chrome's DevTools port (`:9222`) accepts any origin. A page that
reaches either one controls the signed-in browser. Three layers stand in the
way:

- **The broker's request guard**, while the broker is connected: navigation
  goes only to the allowed hosts, and subresources only to public addresses.
- **Chrome's managed policy**, which holds whether or not the broker is
  connected (`agent-computer-chrome-policy`):
  - `URLBlocklist *` with `URLAllowlist` set to the allowed hosts, exactly and
    over https. A frame navigates nowhere else: not to loopback, a metadata
    address, a cluster name, a private address, a redirect hop off the list,
    or a public name that resolves to loopback.
  - `LocalNetworkAccessBlockedForUrls *`. A page, worker or socket never
    reaches a loopback or private address, and no prompt asks a person to
    allow it.
- **The container:** Steel and Chrome run as uid 1000 with no capabilities.
  Chrome's own sandbox is off (`DISABLE_CHROME_SANDBOX`), as it was under root.

`scripts/agent-computer-steel-probe.sh` attacks the first two layers in CI on
every change to the chart's browser or the image pin. It aims each attack at a
loopback witness and counts what arrives. On Chromium 156, every navigation and
page attack from a public page was blocked. Under the image's own policy, every
one of those navigations landed except `file://`.

**What remains:**

- **The policy doesn't stop an allowed host's own script.** Script on an
  allowed origin can still use the session that origin holds. Keep
  `agentComputerAllowedHosts` to first-party hosts, so a third-party host is
  a new review, not a values change.
- **Local Network Access doesn't cover a page served from a private address.**
  It treats private and loopback addresses as one space, so such a page
  reaches Steel freely (the probe's private-page rows). The allowlist is what
  keeps such a page from loading.
- **Policy names are Chrome's.** A Chromium release could rename or drop one,
  and the probe is what catches it. Re-run it when the image pin moves.
- **No egress NetworkPolicy.** Any pod in the cluster can still reach the
  gate's port and must present the token there.

## Day to day

- **Park the browser:** `kubectl scale deploy/steel-<id> --replicas=0`. The
  next computer action wakes it, and the waker answers within about 14 s or
  returns 504.
- **Remove a user:** drop the id from the overlay and deploy. The disk stays
  until you delete `steel-<id>-profile` by hand, and deleting it signs the
  browser out.
- **Gate answers:** a 401 from `steel-<id>:3000` means the backend's
  `AGENT_COMPUTER_STEEL_TOKEN` doesn't match the gate's. The two read the same
  Secret, so a mismatch means one pod predates a rotation; restart it.
- **Waker answers:**
  - 401: the token doesn't match.
  - 404 `no_computer`: the id isn't in `users`.
  - 502: the scale read or patch was refused, so check the Role.
