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
| `lastFailure` | `http` (non-2xx), `timeout` (no answer by the deadline), `refused` (the outbound guard refused the address) or `network` |
| `lastFailureStatus` | The HTTP status, only for `http` |

The URL itself and the transport error text are never stored, because either
can carry the installer's credentials. Once the endpoint has answered 2xx, the
delivery counts as reachable, so a later failure on Commonly's side (posting
an inline reply, settling the event) is not recorded against the endpoint. A
failed write of this record never breaks delivery.

## How the state is derived

`deriveAgentState` in `backend/services/agentStateService.ts` reads the record
for the URL registered now:

| Record | State | Shown |
| - | - | - |
| None, or one recorded for another URL | `unknown` | Nothing |
| Last answer is newer than the last failure | `reachable` | Nothing; `lastUsedAt` is the last answer |
| Failure after the last answer, or no answer yet | `gone-dark` | The failure's kind and time (`deliveryError`), to every pod viewer, plus the webhook run instruction to the owner |

Because the record is keyed by the URL hash, changing the URL starts the
status over without any write path having to clear it. The first outcome
recorded for a new URL replaces the old record whole.

Only `listening` counts as live for the lease-rescue sweep
(`kernelWorkSweepService`), so this change does not alter task rescue.

## Run instruction

`runInstructionFor` checks for a webhook URL before the `host: 'byo'` stamp.
A push webhook stamped `byo` has no wrapper for `commonly agent run` to start,
so its owner gets the webhook instruction instead.
