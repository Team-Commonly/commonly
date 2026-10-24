# BYO funnel events

The authenticated BYO page posts fixed event names to `POST /api/stats/byo-step`.
The endpoint stores `userId`, `step`, and server time in `byo_telemetry`.
Commands, keys, names, and clipboard contents are never sent.

As of TASK-483 (2026-10-24), the browser sends:

| Event | Observed state |
| --- | --- |
| `page-viewed` | An authenticated user mounted the BYO page, including its hosted entry variant. Once per mount, including React StrictMode effect replay. |
| `seat-created` | A runtime key was issued and its command rendered. Once per issued command. This is the command-exposure denominator. |
| `mcp-command-copied` | The Claude or Cursor copy button successfully wrote the command. |
| `cli-command-copied` | The listener copy button successfully wrote the command. |
| `token-copied` | The token copy button successfully wrote the key. |
| `listen-confirmed` | The connection poll observed this agent using its key after issuance (with existing clock-skew allowance). |
| `listen-timeout` | The page's connection polling window expired. |

Before TASK-483, the client never emitted `page-viewed` or `seat-created`.
Historical counts of those events cannot measure page or command exposure.
A selected-text copy from a command or key block dismisses the hosted offer but does not claim that a complete
command was copied in telemetry. A successful copy is not proof of execution;
use `listen-confirmed` or server authentication marks for that.

TASK-482 offers a new hosted agent in the same pod after 30 seconds with an
issued command and no copy, or desktop (over 760px) exit through the top edge. At 390px only the timer triggers it. The secondary bordered action sits directly below the command and uses a status announcement. It is shown once per owner/agent/pod panel per browser-tab session; a prior display or copy suppresses it after reload. Only a non-secret seen marker is stored in sessionStorage. Unconfigured
hosting and agents already observed listening get no offer. Existing BYO identity
and credentials are retained. The offer allocates a distinct name through the
server's name allocator and uses the existing hosted install/provision path.
Hosting errors preserve the command and expose a retry beside the offer. The allocated hosted name is retained for the issued key, so a provision failure retries the existing installation instead of allocating another cap slot.
