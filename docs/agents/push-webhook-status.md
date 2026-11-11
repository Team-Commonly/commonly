# Push webhook status

A push webhook agent is an install whose `config.runtime.webhookUrl` is set.
Commonly POSTs each wake event to that URL (`deliverEventViaWebhook` in
`backend/services/agentEventService.ts`). The pod's agent status for such an
install is measured from those deliveries. It was once reported reachable by
construction, so a dead URL showed as live in every pod.

## What is recorded

Each delivery writes `AgentInstallation.webhookDelivery`:

| Field | Meaning |
| - | - |
| `urlHash` | First 32 hex characters of the SHA-256 of the URL the delivery went to |
| `lastAttemptAt` | The last delivery attempt |
| `lastOkAt` | The last time the endpoint answered 2xx |
| `lastFailedAt` | The last failed delivery |
| `lastFailure` | `http` (non-2xx, or too many redirects), `timeout` (no answer by the deadline), `refused` (the outbound guard refused the address) or `network` (the host doesn't resolve, or the connection failed) |
| `lastFailureStatus` | The HTTP status, only for `http` |

The URL itself and the transport error text are never stored, because either
can carry the installer's credentials. Once the endpoint has answered 2xx, the
delivery counts as reachable, so a later failure on Commonly's side (posting
an inline reply, settling the event) is not recorded against the endpoint. A
2xx whose body passes the size cap counts as answered too. A failed write of
this record never breaks delivery.

The guard throws one error type for every refusal. Its `kind` keeps them apart
without the message, which names the host: `refused` for an address or
response Commonly won't accept, `unresolved` for a host with no DNS answer, and
`redirects` for a redirect loop. A lapsed domain or tunnel is the usual way a
webhook dies, and it reads as `network`, not as Commonly refusing it.

## How the state is derived

`deriveAgentState` in `backend/services/agentStateService.ts` reads the record
for the URL registered now:

| Record | State | Shown |
| - | - | - |
| None, or one recorded for another URL | `unknown` | Nothing |
| Last answer is newer than the last failure | `reachable` | Nothing; `lastUsedAt` is the last answer |
| Failure after the last answer, or no answer yet | `gone-dark` | The failure's kind and time (`deliveryError`), to every pod viewer |

Because the record is keyed by the URL hash, changing the URL starts the
status over without any write path having to clear it. The first outcome
recorded for a new URL replaces the old record whole.

Where it shows: the pod's agent status line and the agent room's status line
say what failed and when. The mention typeahead and the composer warning say
the agent didn't get the last message. Only the owner's composer warning
carries the webhook run instruction.

What it does not change:
- Only `listening` counts as live for the lease-rescue sweep
  (`kernelWorkSweepService`), so task rescue is the same.
- `agentReach` (`neverConnectedMentionService`) reads a push webhook as
  `unknown` even after a failed delivery. Its readers act on a listener that
  stopped checking in: the once-a-day "looks offline" line and the hand-off of
  an ask to the pod's host, which tells the host the agent's computer stopped
  checking in. A push webhook has no listener, and its mention is still
  delivered and retried, so a hand-off would answer twice once the endpoint is
  back.
- The install intro derives `unknown` for a new webhook and keeps its
  invitation.

## Run instruction

`runInstructionFor` checks for a webhook URL before the `host: 'byo'` stamp.
A push webhook stamped `byo` has no wrapper for `commonly agent run` to start,
so its owner gets the webhook instruction instead.
