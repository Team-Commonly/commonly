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
2. Add the owner's user id to `agentComputer.users` in the agent-computer
   overlay: the `DEV_HELM_AGENT_COMPUTER` repo secret, which `Deploy Dev`
   writes to its own `-f` file after the private one. A GitHub secret can't
   be read back, so keep the overlay's source in an operator-private file
   and set the secret from it whole.
3. Run `Deploy Dev`. Then set `agentComputer.steel.gate.imageTag` in the
   same overlay to that deploy's backend tag. Every deploy moves the backend tag,
   and any change to the Steel pod template restarts the browser, so an
   unpinned gate drops a live session on each deploy.
4. The backend reads both tokens only at pod start (the secret refs are
   optional). If the backend pod started before the ExternalSecrets synced,
   restart it. `agentComputerEnabled()` stays false until the env holds both.
5. Give the computer tools to exactly one installation:
   - it must be a native install (`runtimeType: 'native'`), owned by the
     person whose id is in `users`;
   - `native` is a cloud runtime at install, so the installer must be an
     admin or carry the `cloudAgents` entitlement
     (`cloud_agents_not_entitled` otherwise);
   - a hosted install can't stand in for it, on either engine. Neither reads
     the install's own `config.tools`. A hosted turn on the native engine runs
     the fixed list `hostedNativeRunConfig` builds (`HOSTED_NATIVE_TOOLS`), and
     one on the Durable Object runs the worker's `buildCapTools`. Neither list
     has a computer tool;
   - `config.tools` lists the `computer_*` tools, `computer_request_takeover`
     included. A declared list is the whole set of the runtime's own tools
     for a native install: an install with no list gets every one that isn't
     opt-in, and declaring one drops the rest. So it also names every other
     tool the agent should keep, such as `commonly_read_context` and
     `commonly_post_message`, and the memory tools if it uses them;
   - connector tools are not in that list. A live grant on the pod or the seat
     adds its tools on top of `config.tools`, and only revoking the grant
     removes them. Check that no live grant reaches the agent's pod or seat
     (`GET /api/pods/:podId/grants` returns none) before giving it the
     computer, and after every reinstall;
   - no other installation lists them.
   - The agent uses the computer only on a turn whose message its owner
     wrote (`computer_requester_denied` otherwise), so a heartbeat or another
     member's message can't start a walk.
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
  - `URLBlocklist *` with `URLAllowlist` set to the allowed hosts, exactly,
    over https and on port 443. A frame navigates nowhere else: not to
    loopback, a metadata address, a cluster name, a private address, a
    redirect hop from an allowed host to loopback, or a public name that
    resolves to loopback. A host that is an IP literal, or carries a port or
    path, fails the chart render.
  - `LoopbackNetworkBlockedForUrls *` and `LocalNetworkAccessBlockedForUrls *`
    (Chromium splits loopback out since 146). They state that no page may
    reach a loopback or private address. Headless Chrome already refuses a
    public page's requests there, and the probe can't show these entries add
    anything to that default (below).
- **The container:** Steel and Chrome run as uid 1000 with no capabilities.
  Chrome's own sandbox is off (`DISABLE_CHROME_SANDBOX`), as it was under root.

`scripts/agent-computer-steel-probe.sh` attacks the first two layers in CI on
every change to the chart's browser or the image pin. It starts the browser the
way the broker does (`POST /v1/sessions` with `persist: true`), then aims each
attack at a loopback witness and counts what arrives. Rows that can't be aimed
at the witness say how they were counted. On Chromium 156 under the chart's
policy:

- **Navigations.** Every navigation and redirect hop above was refused. Under
  the image's own policy, each witnessed one reached loopback, and each of the
  others was not refused (only `file://` was).
- **A public page's requests.** Fetches, images, sockets, workers and frames
  to loopback were blocked, as were reads of Steel's API and the DevTools
  socket. They were blocked under the image's own policy too: that is Chrome's
  default.
- **Controls.** The allowed pages loaded, a public cross-host fetch worked,
  the redirect's first leg reached the allowed host, and every Chrome process
  ran as uid 1000 with no capabilities.

**What remains:**

- **The policy doesn't stop an allowed host's own script.** Script on an
  allowed origin can still use the session that origin holds. Keep
  `agentComputerAllowedHosts` to first-party hosts, so a third-party host is
  a new review, not a values change.
- **Local Network Access doesn't cover a page served from a private address.**
  It treats private and loopback addresses as one space, so such a page
  reaches Steel freely (the probe's private-page rows). The allowlist is what
  keeps such a page from loading, so never allow a host that resolves to a
  private address.
- **The network entries are unmeasured beyond Chrome's default.** A DevTools
  permission grant gets past both, because a DevTools override outranks
  policy. Only a DevTools client can set one, and that client already
  controls the browser. If a Chromium release changes the default, the
  probe's public-page rows show whether these entries hold.
- **Policy names are Chrome's.** If a release renames or drops a URL entry,
  the navigation rows fail. Re-run the probe when the image pin moves.
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
