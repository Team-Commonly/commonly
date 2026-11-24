# Two backend processes on the single VM

The single-VM stack (`deploy/vm/`, runbook [single-vm.md](./single-vm.md)) can
run a second, web-only backend process beside the first. It's off by default
and sits behind the `two-workers` compose profile until it's rolled.

## Why

A load test on a copy of the VM (e2-standard-2, scheduler off, stub LLM) found
the limit is one Node process. Polling agents bent at about 300, hosted turns
at 240 to 480 a minute, and both together at about 200 agents plus 120 turns a
minute. At each bend the backend process held one core near 100% while the
host's load stayed under 2 of its 2 vCPUs. A second process can use the idle
core.

**Measurements decide the roll, not the build.** Land the change with the
profile off, which is today's stack plus Redis. Turn the profile on only if
production's peak backend CPU and event-loop utilisation, read against the
load-test bends, show one process running out of headroom. The PR that added
this records both numbers.

## Shape

| Service | Role | Profile |
|---------|------|---------|
| `redis` | Shared state between backend processes. Stores nothing: no snapshot, no append-only file, `/data` on tmpfs, `maxmemory` with `noeviction`, a password, no host port. | always on |
| `backend` | Web and worker, as today: the scheduler, the Discord gateway and the other singleton jobs run here only. Serves through a Redis outage. | always on |
| `backend-2` | Web only (`RUN_WORKER=0`), with the same image, env, mounts and checks as `backend`. `REQUIRE_SHARED_REDIS=1`: it stops serving when it loses Redis. | `two-workers` |
| `api-lb` | nginx (`deploy/vm/api-lb/nginx.conf`). Spreads the API across both backends, sticky by the end user's address, and fails over to `backend`. | `two-workers` |

Native turns run in both processes, under the runner lease, as they do in a
single process.

`backend/__tests__/unit/deployment/singleVmCompose.test.js` pins all of this:
- `backend-2` is `backend`'s twin plus its two env lines.
- Feeding each backend service's env through the real
  `startBackgroundServices` starts the scheduler and the Discord gateway
  exactly once.
- Redis has the settings above.
- api-lb keeps the end user's address, sticks, and fails over without
  replaying a body.

`scripts/vm-two-workers/lb-smoke.sh` runs api-lb's config in its pinned image
in front of two stand-in backends and checks the last three behaviours live.

## What Redis carries

- **The socket.io adapter** (`backend/config/socket.ts`). It turns on wherever
  `REDIS_HOST` is set, not only on Kubernetes. A pod-room emit, a
  `socketsLeave` and a `disconnectSockets` reach the sockets of every process.
  This covers revocations: a revoked session, a pod leave, a revoked agent
  token.
- **The process bus** (`backend/services/processBus.ts`). These are
  cross-process hints for state each process keeps in memory. The process that
  changes the state applies the change locally and publishes it, and each
  other process applies it to its own copy. A hint published while Redis is
  down is lost, so every subscriber keeps its own backstop:

  | Channel | What it carries | Backstop |
  |---------|-----------------|----------|
  | `agent-ws-push` | A wake for an agent socket held by the other process | The agent's own poll; a push is only a wake, `list()` still claims |
  | `cloud-runtime-cache-clear` | An entitlement or role change | The cache's 60 s TTL |
  | `hosted-mcp-drift-forget` | A removed or reconnected hosted-MCP credential | The drift cache's TTL |
  | `global-model-config-changed` | An admin's model-config save | The config cache's 15 s TTL |

- **Rate-limit counts.** The security-relevant limiters count in
  `SharedRateLimitStore` (prefix `rl:<name>:`; a test keeps names unique and
  prefix-free). The Telegram connect-code attempts count there too. While Redis
  is down they count in memory, so each process allows the full limit (×2).

## When Redis fails

| | backend | backend-2 |
|---|---|---|
| Redis down at boot | Connects for up to 15 s, then serves alone: no adapter until it restarts, limits in memory | Stops (drops its sockets, SIGTERM drain), and compose restarts it; it stops again until Redis is back |
| Redis lost later | Keeps serving; the adapter and bus reconnect on their own | Stops the same way |

While `backend-2` is stopped or draining, `api-lb` sends everything to
`backend`. A refused or timed-out connection, a 502 or a 503 moves a request to
the other process, and a request whose body was already sent is never
replayed. Its clients' sockets reconnect through `api-lb` to `backend`.

**One case needs a hand.** If `backend` booted while Redis was down, it runs
without the adapter until it restarts. With `backend-2` back, the two are
split: an emit from one doesn't reach the other's sockets. Its log says
`Continuing without Redis adapter`. With the profile on, restart `backend`
once Redis is healthy.

## Roll (SRE)

1. **Before the deploy that brings this change,** add `REDIS_PASSWORD` to
   `deploy/vm/.env` (a long random string: `openssl rand -hex 32`, at mode
   0600). Compose refuses to start without it.
2. Deploy the SHA as usual ([single-vm.md § Deploy a SHA](./single-vm.md#deploy-a-sha)).
   `redis` starts, and `backend` now counts the shared limits in Redis.
   `docker compose ps` shows `redis` healthy. The backend log shows
   `Redis adapter enabled for multi-process broadcasting`.
3. Turn the profile on, only once the numbers call for it:
   ```bash
   echo "COMPOSE_PROFILES=two-workers" >> .env
   docker compose up -d --wait
   ```
4. Point the tunnel's API hostname at `http://api-lb:5000` instead of
   `http://backend:5000`, on the Cloudflare side.
5. Smoke as after a deploy. `docker compose logs backend-2` shows no
   scheduler or Discord gateway start.

**Rollback** is the reverse. Point the API hostname back at
`http://backend:5000`, then remove the `COMPOSE_PROFILES` line and run
`docker compose --profile two-workers rm -sf backend-2 api-lb`.

## Out of scope

These still assume one process. None blocks the roll, and each is rare or
off on the VM.

- **Agent-computer takeover state** is in memory. The agent computer is off on
  the VM.
- **IDENTITY.md saves** are serialised per process. Two concurrent saves of one
  agent's file on different processes can lose one.
- **The skills catalog refresh** writes to local disk on the worker. The
  web-only process serves the image's copy.
- **The ask-fallback "one hand-off per message" guard** is per process, so it
  can wake the host twice.
- **commonly-bot's accounts file** can be written by either process. Each write
  is regenerated whole from the database.
- **Per process, and accepted:**
  - per-user socket rate budgets, for a user whose tabs land on both
    processes, which stickiness makes rare;
  - the Discord summary cooldown;
  - the summarizer caches;
  - the Sentry cap;
  - the in-flight guards of three system-line services;
  - stop lines;
  - the typing safety timer;
  - the agent auth refusal counter shown to admins;
  - Discord webhook pacing;
  - first-boot seed upserts.
- **The F597 long-poll waiter map** is per process. Its 2.5 s pending-wake
  recheck keeps it correct across processes, just slower. An
  `agent-event-wake` bus channel follows once that change lands.
