# Hosted turn shutdown

TASK-500 adds graceful shutdown to the backend server entry point. It pairs with the background-worker split (#2475), whose worker deployment renders the same backend template and starts the same server entry point.

On SIGTERM or SIGINT:

1. Close in-process admission synchronously. Native enqueue persists new wakes as pending; both recovery sweeps stop claiming. Async claims already in flight are tracked and dispatch returns them to pending instead of starting another model turn.
2. Stop the local scheduler and accepting new HTTP connections. Readiness returns 503 while draining. Liveness is unchanged.
3. Await all tracked admission, native turns and terminal event writes. A successful model promise alone is not completion: its event acknowledgement must finish too.
4. After 150 seconds, return this process's unfinished deliveries to pending with a status + delivery-nonce compare-and-swap. Keep attempts unchanged. A sibling's delivery is never selected by a broad pod query; late settlement from the old nonce cannot acknowledge its replacement.
5. Exit when cleanup finishes. A 165-second watchdog exits nonzero if cleanup hangs. The chart allows 180 seconds total, including the existing 10-second preStop delay, leaving 15 seconds after the normal drain deadline for DB cleanup and 5 seconds after the watchdog before SIGKILL.

This is at-least-once recovery, not exactly-once provider execution. A provider side effect from a timed-out turn may already have happened. Existing approval/deduplication behavior still applies. SIGKILL, process crashes and unavailable DB writes still use the existing stale-delivery recovery sweeps; this change does not claim lossless recovery from those failures. Completed model turns whose acknowledgement failed remain delivered for the existing succeeded-run recovery path, rather than being blindly requeued and answered twice.

## Verify a rollout

Verify that the replacement process responsible for scheduling actually starts the scheduler, especially in worker-split deployments. Startup garbage collection can recover eligible wakes immediately; otherwise recovery waits for the ten-minute scheduled sweep. Its one-minute minimum event age can skip a fresh wake at one sweep, so allow roughly 11 minutes for pickup plus turn execution before a human-visible reply. This is scheduled recovery, not immediate delivery.

Use a non-production test pod and a controlled long-turn provider. Start one native turn, then send SIGTERM. Confirm readiness refuses new traffic, a second wake remains pending, the original turn and its event acknowledgement finish, and `[shutdown] hosted drain complete` appears before process exit. Check the replacement process handles the pending wake. A forced deadline case should show the unfinished event pending with its old nonce invalidated; confirm any provider write independently before retrying it.

Also force-kill a test process during a controlled turn. SIGKILL runs no shutdown handler, so confirm the delivery stays delivered until the replacement's stuck-redispatch sweep recovers it. A spot reclaim can provide less notice than the drain budget and needs the same recovery path. Record the recovery delay and verify that an old nonce cannot settle the replacement's claim.

A deadline requeue reruns the tool-using turn. Any provider write or posted message that happened before interruption can repeat; inspect those effects independently before retrying.

Automated tests use real Mongo AgentEvent rows and a fake long `runAgent`, plus signal-handler tests. They cover graceful success/failure, claim/lookup races, waiting for the acknowledgement, timeout requeue, sibling ownership and late settlement. An actual Kubernetes rollout remains an operator deployment check.
