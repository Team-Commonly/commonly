# Hosted turn shutdown

TASK-500 adds graceful shutdown to the backend server entry point. It pairs with the background-worker split (#2475), whose worker deployment renders the same backend template and starts the same server entry point.

On SIGTERM or SIGINT:

1. Close in-process admission synchronously. Native enqueue persists new wakes as pending; both recovery sweeps stop claiming. Async claims already in flight are tracked and dispatch returns them to pending instead of starting another model turn.
2. Stop the local scheduler and accepting new HTTP connections. Readiness returns 503 while draining. Liveness is unchanged.
3. Await all tracked admission, native turns and terminal event writes. A successful model promise alone is not completion: its event acknowledgement must finish too.
4. After 150 seconds, return this process's unfinished deliveries to pending with a status + delivery-nonce compare-and-swap. Keep attempts unchanged. A sibling's delivery is never selected by a broad pod query; late settlement from the old nonce cannot acknowledge its replacement.
5. Exit when cleanup finishes. A 165-second watchdog exits nonzero if cleanup hangs. The chart allows 180 seconds total, including the existing 10-second preStop delay, leaving 15 seconds after the normal drain deadline for DB cleanup and 5 seconds after the watchdog before SIGKILL.

This is at-least-once recovery, not exactly-once provider execution. A provider side effect from a timed-out turn may already have happened. Existing approval/deduplication behavior still applies. SIGKILL, process crashes and unavailable DB writes still use the existing stale-delivery recovery sweeps; this change does not claim lossless recovery from those failures. Completed model turns whose acknowledgement failed remain delivered for the existing succeeded-run recovery path, rather than being blindly requeued and answered twice.

## Where native turns run (F52)

One process at a time runs native turns. The lane that keeps an agent's turns in a pod in order lives in memory, so two processes running turns could start two of that agent's turns in one pod at once, each answering before the other posts. Measured on prod over the 7 days to 2026-11-09, 20.7% of follow-up turns arrived while an earlier turn in their lane was still running.

- **The runner lease.** Every process that may run native turns (the worker, a single-process pod, a paused split's web pod) takes a Mongo lease (`native-turn-runner` in `scheduler_heartbeat_leases`) and runs native turns only while it holds it. A turn that arrives at a process without the lease is written `pending` and marked `inProcessQueued`, and the holder claims it from that queue every 500 ms (`AGENT_EVENT_IN_PROCESS_POLL_MS`) with the same compare-and-set the sweeps use. A draining holder keeps renewing until its turns finish, then releases, so a replacement started beside it (an eviction, a node drain, a spot reclaim, a rolling deploy's surge pod) waits instead of running a second turn in the same lane.
  - The lease lasts 180 s from each write and is renewed every 5 s. A holder starts no turn in its last 165 s: the drain's 150 s bound on one turn (the 60 s wall clock is checked only between model calls of up to 45 s each), plus 15 s for another pod's clock running ahead. The check runs immediately before the model call, so a turn that waited in its lane past the window goes back to the queue rather than run.
  - So a holder that dies, or is alive but cannot reach Mongo, is replaced when its lease runs out and nothing it started is still running. A drain that times out leaves the lease to run out for the same reason, rather than handing it over.
  - A requeued turn whose run already succeeded (it answered after its drain gave up on it) is acked by the next holder, not answered again.
  - The cost is a delayed reply, at most about 3 minutes after a holder dies without draining, never a doubled one.
- **Worker split on and running:** the chart sets `NATIVE_TURNS_ON_WORKER=1` on web pods. A web pod never runs a native turn: every one goes to the queue, and the worker runs it in its own lanes, beside its own scheduler wakes. A hosted Start on a web pod marks what waited instead of running it.
- **Worker split paused:** web pods run `RUN_WORKER=0`, so there is no scheduler, but each web pod still takes the lease and runs native turns as the holder. The verifier below still keeps a paused split at one web replica.
- **External drivers never see a queued turn.** `list()` skips marked rows and the WebSocket push is not sent for them.
- **Cost:** a queued turn waits for the next poll, then three or four Mongo round trips (read the queue, look up the agent, sometimes a second lookup for a projection, claim), each about 45 ms from the cluster. On a quiet queue that is about 0.4 s on average and under 0.7 s at most, against a native reply's 4.2 s median. A pass claims up to 50 rows one after another, so in a burst the last row waits a few seconds more. No Redis is involved, so a Redis outage changes nothing here.
- **Restarts:** a drained runner's unfinished turns, its own scheduler wakes included, keep or get the mark, so the next holder picks them up on its first pass, not on the ten-minute sweep.
- **Rolling back from a running worker:** go to `backend.worker.enabled: false` with one web replica. Paused works too, since its web pod reads the queue, but it runs no scheduler, so the ten-minute rescue sweeps stop until the split is on again.

`scripts/verify-backend-worker-chart.sh` refuses more than one web replica unless the worker is running and web pods carry `NATIVE_TURNS_ON_WORKER=1`. So for a lane taking the split in two steps, the paused step keeps one web replica, and the unpaused step is the one that adds the second.

## Verify a rollout

Verify that the replacement process responsible for scheduling actually starts the scheduler, especially in worker-split deployments. Startup garbage collection can recover eligible wakes immediately; otherwise recovery waits for the ten-minute scheduled sweep. Its one-minute minimum event age can skip a fresh wake at one sweep, so allow roughly 11 minutes for pickup plus turn execution before a human-visible reply. This is scheduled recovery, not immediate delivery.

Use a non-production test pod and a controlled long-turn provider. Start one native turn, then send SIGTERM. Confirm readiness refuses new traffic, a second wake remains pending, the original turn and its event acknowledgement finish, and `[shutdown] hosted drain complete` appears before process exit. Check the replacement process handles the pending wake. A forced deadline case should show the unfinished event pending with its old nonce invalidated; confirm any provider write independently before retrying it.

Also force-kill a test process during a controlled turn. SIGKILL runs no shutdown handler, so confirm the delivery stays delivered until the replacement's stuck-redispatch sweep recovers it. A spot reclaim can provide less notice than the drain budget and needs the same recovery path. Record the recovery delay and verify that an old nonce cannot settle the replacement's claim.

A deadline requeue reruns the tool-using turn. Any provider write or posted message that happened before interruption can repeat; inspect those effects independently before retrying.

Automated tests use real Mongo AgentEvent rows and a fake long `runAgent`, plus signal-handler tests. They cover graceful success/failure, claim/lookup races, waiting for the acknowledgement, timeout requeue, sibling ownership and late settlement. An actual Kubernetes rollout remains an operator deployment check.
