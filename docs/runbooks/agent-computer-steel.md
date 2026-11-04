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
  - It runs Steel with `--no-nginx`. The broker reaches CDP through Steel's
    own WebSocket proxy on `:3000`. The bundled nginx on `:9223` forwards the
    caller's Host header, and Chrome answers `/json/version` only for an IP or
    `localhost` Host.
  - The Deployment has no `replicas` field. The waker owns scale, and helm's
    three-way merge then leaves a live session alone on upgrade.
- One `agent-computer-waker` Deployment and Service, shared by all users.
  - The code is `backend/services/agentComputerWaker.ts`, run from the
    backend image.
  - Its Role is limited to `get` on the rendered `steel-*` Deployments and
    `get`/`patch` on their `scale`.
  - Its token is the `agent-computer-waker` Secret, key `token`, which has
    its own ExternalSecret. A missing key fails only that sync, never
    `api-keys`.

The browser holds a signed-in session. Under ADR-015 it stays off spot, so
`values-dev.yaml` pins both pods to the dev pool.

## Turning it on

1. Create the Secret Manager key `<keyPrefix>agent-computer-waker-token` with
   a random value of 32 bytes or more.
2. Add the owner's user id to `agentComputer.users` in the private overlay.
3. Run `Deploy Dev`.
4. The backend reads the token only at pod start (the secret ref is optional).
   If the backend pod started before the ExternalSecret synced, restart it.
   `agentComputerEnabled()` stays false until the env holds the token.
5. Before the sign-in, confirm that the backend is the only peer that can
   reach `steel-{userId}:3000`. Steel's API takes no credentials, and the
   chart adds no NetworkPolicy.
6. Give the computer tools to exactly one installation:
   - it must be a native install (`runtimeType: 'native'`), owned by the
     person whose id is in `users`;
   - `config.tools` lists the `computer_*` tools, `computer_request_takeover`
     included;
   - no other installation lists them.
7. Do the one-time sign-in through `computer_request_takeover`. The owner signs
   in by hand in the takeover UI, and the agent never types a password. The
   profile disk keeps that session across restarts.

## Day to day

- **Park the browser:** `kubectl scale deploy/steel-<id> --replicas=0`. The
  next computer action wakes it, and the waker answers within about 18 s or
  returns 504.
- **Remove a user:** drop the id from the overlay and deploy. The disk stays
  until you delete `steel-<id>-profile` by hand, and deleting it signs the
  browser out.
- **Waker answers:**
  - 401: the token doesn't match.
  - 404 `no_computer`: the id isn't in `users`.
  - 502: the scale read or patch was refused, so check the Role.
