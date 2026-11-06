# Inbox completion checkpoints (TASK-481)

A fetched pod batch remains one model turn. Each waking item includes its event
ID and current delivery nonce. After committed tool-side work (including any tool-posted reply), or an
intentional NO_REPLY, the child calls `commonly_checkpoint_event`. It releases any held
message claim first, with the correct completed/declined outcome. The checkpoint
uses the existing authenticated event ack endpoint and writes no chat message.
It does not complete a board task. Never checkpoint unfinished work or an
answer held for final CLI text: the wrapper must post that answer before ack.

A successful checkpoint is terminal in the kernel. A later child timeout or
wrapper crash does not undo it. The normal batch-completion ack is idempotent
for events already checkpointed. Unfinished items remain eligible for the
normal stale-delivery requeue. Delivery is still at least once: a child crash
between its external side effect and checkpoint can replay that item.

## Long turns and ownership

The wrapper renews current batch deliveries every minute through
`POST /api/agents/runtime/events/renew` while awaiting the child. Renewal only
updates `deliveredAt`, with a CAS on the authenticated seat, instance, delivered
status and nonce. It never acknowledges an event or increments attempts. This
prevents the ten-minute GC threshold from invalidating a live 45-minute turn.
An independent deadline stops renewal even if the adapter promise never
settles or its child ignores SIGTERM. The budget uses
COMMONLY_AGENT_RUN_TIMEOUT_MS (15 minutes by default), is passed to the adapter
as timeoutMs, and starts at batch admission, so setup counts too. An adapter
may enforce a shorter cap. A queued callback cannot renew after expiry.
Stopping renewal allows ordinary GC recovery after a crash or deadline.

Unknown, stale, foreign or terminal deliveries cannot be renewed. A failed
renewal is logged; it is never treated as progress. Checkpoints with stale
nonces remain errors. Renewing a stale nonce cannot acquire the new delivery.

## Held events and stopping (F189, F182)

A claimed event is `delivered`, and no poll returns a delivered row. So events
the wrapper holds between polls live in memory: a failed turn's events carried
to its retry (renewed every minute through a circuit wait of up to 18 minutes),
the greeting carried one interval, and a page a poll claimed as a stop arrived.
Before this change, a stop dropped all of them. They then stayed delivered to
the dead process until the requeue sweep (10–20 minutes, one attempt spent per
lap). A walk on 2026-11-05 restarted a circuit-open seat five times, and each
restart's first poll could not see the mention the previous one held.

Now a stopping run hands those events back through
`POST /api/agents/runtime/events/release` (`{ events: [{ eventId, deliveryId }] }`,
1–50 per call). The release is a CAS on the authenticated seat, instance,
delivered status and nonce. It sets the row to `pending` and clears the nonce.
It leaves `attempts` alone, because attempts counts deliveries. The next run
claims the event on its first poll under a new nonce. Once the stopping run has
released an event it can no longer ack it, so only a later delivery can answer
it. That is not exactly once: a crash or forced kill mid-turn can still lead to
a redelivery after work was done, as with any at-least-once delivery, and the
ceiling below bounds how often that can repeat.

A release has its own ceiling, because a pending row is outside the requeue cap
and the CLI's three-strike count resets on every restart. Without one, a poison
event would loop through restarts forever, and a turn could loop itself by
POSTing its own `deliveryId`. The server refuses a release once `attempts`
reaches twice `AGENT_EVENT_REQUEUE_MAX_ATTEMPTS` (6 by default). Every lap
through a release is a fresh claim, and a claim raises `attempts`, so the
ceiling bounds restarts and repeated releases from one process alike. A refused
event is returned in `atCeiling`, stays `delivered`, and the sweep retires it
with its visible line; the CLI logs it as "left to the requeue (at the
redelivery ceiling)". Below the ceiling a released event is redelivered and
never retired for the restarts it waited through. The requeue cap still bounds
a delivery that goes silent, such as a crash or a SIGKILL.

- An idle stop (`stop()`) cancels the scheduled tick, so a run waiting out a
  circuit exits at once. `stop()` returns one promise that resolves once the
  hand-back has answered, whether the idle stop or the in-flight tick does it.
- A stop during a tick takes effect when the tick ends. A turn that fails after
  the stop hands back its events, with no retry strike. A page claimed by a poll
  in flight hands back the groups it never ran.
- A running seat lets an event go after three local failures, and it goes to
  the requeue as before. A stop wins over that limit: an event in its third
  failing turn when the stop arrives is handed back, and the server's ceiling
  bounds it.
- A stop hands back everything else the tick claimed and left unsettled, on
  every planned exit: a digest a batch left unread, a digest-only group, and
  later groups skipped by a failure or a stale ack. The server claims a digest
  alongside a wake, so these can be `delivered` to this run. A running seat
  still leaves them to the requeue, and so does an unexpected throw. An event
  whose turn finished but whose ack never landed is not handed back, because a
  hand-back would run it again.
- A stalled `agent run` exits at once, so nothing is handed back: the page its
  hung poll claimed and anything it carried are left to the requeue.
- An older server without the route, or a failed request, leaves the events to
  the requeue. The log says so, naming the count.

## What a pod hears when a turn can't run

No model turn can explain a key that stopped working, so the wrapper posts one
fixed line (`cli/src/lib/turn-failure-notice.js`) to each pod with someone
waiting on an answer. It covers three causes: a key or login the provider
refused, a seat that wouldn't start, and an allowance or budget that ran out. A
pod hears each cause at most once an hour, and a restart doesn't reset that.

The line fires on exact wordings, not on the failure classes in `spawn-retry.js`.
A class only picks a backoff, so a loose match there costs a slower retry. Here
it tells a person something untrue: a panic at `client.rs:401` once read as an
expired key. A new wording goes in the list once a seat has logged it, and
anything unmatched stays silent in the pod, as it was before.

The line never quotes the error. A gateway budget refusal carries a masked key,
its alias and dollar figures.

Budget enforcement lags. On 2026-11-06 a key capped at $0.00005 spent $0.0154
before the gateway started refusing it, so a walk needs a key that is already
over budget.

## Release and verification

This requires all three pieces: deployed backend renewal route, published CLI
prompt/renewal loop, and published MCP checkpoint tool. Relaunch wren against
those releases and verify the tool is present. Publishing alone does not change
an existing pinned seat launcher. Old MCP versions continue completion-only
acks; old backend versions reject renewal and retain their existing retry path.
Do not report rollout complete from source tests alone.

The regression runs a fake five-event turn through the real CLI loop and MCP
tool handler. Three successful checkpoints precede timeout; the next simulated
poll contains only the other two. A real Mongo test separately checkpoints three
of five events through AgentEventService, runs actual GC and observes exactly
two pending rows. Another actual-GC test proves a renewed delivery stays live.
Identity, instance, nonce and terminal-state refusal cases protect the renewal.

Live proof still required: handle and checkpoint part of a throwaway batch,
interrupt the turn, and observe only unfinished events after requeue. Inspect
kernel event statuses and nonce-safe refusal logs; do not infer progress from
chat output or elapsed time.
