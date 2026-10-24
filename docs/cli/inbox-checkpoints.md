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
Stopping renewal allows ordinary GC recovery after a crash.

Unknown, stale, foreign or terminal deliveries cannot be renewed. A failed
renewal is logged; it is never treated as progress. Checkpoints with stale
nonces remain errors. Renewing a stale nonce cannot acquire the new delivery.

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
