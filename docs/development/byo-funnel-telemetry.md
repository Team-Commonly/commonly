# BYO funnel events

The authenticated BYO page posts fixed event names to `POST /api/stats/byo-step`.
The endpoint stores `userId`, `step`, and server time in `byo_telemetry`.
Commands, keys, names, and clipboard contents are never sent.

As of TASK-483 and TASK-493 (2026-10-24), the browser sends:

| Event | Observed state |
| --- | --- |
| `page-viewed` | An authenticated user mounted the BYO page, including its hosted entry variant. Once per mount, including React StrictMode effect replay. |
| `seat-created` | A runtime key was issued and its command rendered. Once per issued command. This is the command-exposure denominator. |
| `mcp-command-copied` | The Claude or Cursor copy button successfully wrote the command. |
| `cli-command-copied` | The listener copy button successfully wrote the command. |
| `daemon-command-copied` | The "Add a computer" daemon command copy button successfully wrote the command. Telemetry only: it sets no onboarding copy mark, so stalled-connect messaging is unchanged. Before TASK-653 this copy posted nothing, so a user who used this path was invisible to the copy count. |
| `token-copied` | The token copy button successfully wrote the key. |
| `listen-confirmed` | The connection poll observed this agent using its key after issuance (with existing clock-skew allowance). |
| `hosted-offer-shown` | The timer or desktop exit-intent path displayed the hosted offer. The shared session guard records it once, including when both triggers run. |
| `hosted-offer-clicked` | The user activated the offer to start hosted setup. Recorded before name lookup, including failed attempts; concurrent duplicate activations are suppressed. A retry records another activation. This is separate from choosing the initial hosted mode. |
| `listen-timeout` | The page's connection polling window expired. |

The backend writes one more row, `seat-registered`, itself; the browser cannot post it (the route answers 400). It is written once per runtime token, on the token's first authenticated call (`middleware/agentRuntimeAuth.ts`), with the installing user as `userId`. It fires whether or not the user is still on the page, so it measures registration when `listen-confirmed` is missing. It is not limited to BYO: a hosted seat's first call also writes it. Its `_id` is `seat-registered:<sha256 of the token record hash>`, so a racing second first call is a duplicate-key no-op and the row is never written twice.

Read back `step`, `userId` and `at` (server time). The field is `at`, not `createdAt`; a count on `createdAt` sees nothing. Rows from the browser have a Mongo-generated `_id`.

Before TASK-483, the client never emitted `page-viewed` or `seat-created`.
Historical counts of those events cannot measure page or command exposure.
A selected-text copy from a command or key block dismisses the hosted offer but does not claim that a complete
command was copied in telemetry. A successful copy is not proof of execution;
use `listen-confirmed` or server authentication marks for that.

TASK-482 offers a new hosted agent in the same pod after 30 seconds with an
issued command and no copy, or desktop (over 760px) exit through the top edge. At 390px only the timer triggers it. The offer is a sticky bottom bar with an ink action, a top border and a status announcement. Its height is reserved from the first render, and its negative margin adds no flow height when it appears. It is shown once per owner/agent/pod panel per browser-tab session; a prior display or copy suppresses it after reload. Only a non-secret seen marker is stored in sessionStorage. Unconfigured
hosting and agents already observed listening get no offer. Existing BYO identity
and credentials are retained. The offer allocates a distinct name through the
server's name allocator and uses the existing hosted install/provision path.
Hosting errors preserve the command and expose a retry beside the offer. The allocated hosted name is retained for the issued key, so a provision failure retries the existing installation instead of allocating another cap slot.

The placement invariant is checked in real Chromium by
`e2e/byo-offer-layout.spec.ts`: with all command blocks expanded, each block's
viewport top must be identical before and after the offer appears. The memory
textarea, final action row and both action buttons must also stay stationary,
with those controls fully in the viewport while the timer fires. The bar must
remain visible at both scroll extremes and must not cover the last control at
full scroll; the reserved height must equal its measured height. The DOM order
is also pinned in the BYO render and v2 layout-invariant Jest tests.
