# Agent computer staging bridge

TASK-276 is a staging-only trial. A human's Steel container owns one persistent
browser profile on that human's PVC. The Commonly backend is the only network
peer allowed to reach Steel's unauthenticated API, CDP, or live view. Native
agent installations opt in to the six `computer_*` tools; legacy installs and
production do not receive them.

## Runtime contract

- The backend calls the scoped waker with
  `POST {AGENT_COMPUTER_WAKER_URL}/v1/users/{24-hex userId}/wake` and an ESO-held
  bearer token. The waker waits for the user's Steel pod to be ready. The
  backend has no Kubernetes scale permission.
- It then uses the in-namespace `steel-{userId}` Service, API `:3000` and CDP
  `:9223`. The broker lists sessions and attaches to an existing `idle` or
  `live` session. It creates a session only when none is active; an unfamiliar
  state fails closed because a second session relaunches the browser.
- One backend broker connection is cached per human. Each installation gets
  one distinct Playwright page in that shared persistent browser context.
  This staging release has one backend replica. Human takeover state is also
  stored in Mongo so a spot restart does not silently return control to an
  agent. The installation-to-tab binding stores the browser-owned CDP target
  ID in Mongo; recovery ignores page-writable `window.name` and unbound tabs.
  A new backend connection gets a new frame epoch, invalidating stale human
  input.
- `AGENT_COMPUTER_ENABLED` defaults to `false`; the trial needs that flag,
  both Steel endpoint templates, the waker URL/token, and an allowed host list.
  Staging supplies the Steel templates and LinkedIn host list. SRE supplies
  the waker URL and `agent-computer-waker` Secret key `token` before the walk.

## Agent and human boundary

The installation owner is taken from `AgentInstallation.installedBy`, never a
tool argument. The triggering message must also be from that owner; another
pod member cannot steer the agent into the owner's browser. At dispatch the
backend confirms the owner is a human User. An agent
can navigate only to allowlisted HTTPS hosts with no URL query, read a bounded
accessibility snapshot, click an inspectable non-commit control, fill a
non-secret field, or view a bounded screenshot. Page text and screenshots are
untrusted model input; the AgentRun records only their metadata. The broker
marks the turn web-tainted when either read succeeds, narrowing later tools and
blocking posts to externally bridged pods. Same-tab inspection and drafting
remain available; navigation to a model-chosen address does not.
The broker
intercepts the shared browser context, including the first popup request.
Unknown tabs are denied. It blocks non-GET/HEAD/OPTIONS page requests while
the agent controls the tab. During human takeover, writes remain blocked until
a human action; each subsequent write is paused for a separate human decision.
Send/submit controls and ambiguous clickable elements yield `person_required`.

`computer_request_takeover` persists a pause for that installation. While it
is active, agent actions fail. The person's authenticated UI uses:

| Endpoint | Response / input |
| --- | --- |
| `GET /api/agent-computer/:installationId/status` | `{active,url,frameWidth,frameHeight,frameRevision,pendingWrites}`; status captures a current CSS-pixel frame; pending writes show only an opaque ID, method and URL without query |
| `GET /api/agent-computer/:installationId/frame` | no-store PNG for the last status capture |
| `POST /api/agent-computer/:installationId/click` | `{x,y,frameRevision}` in frame pixels |
| `POST /api/agent-computer/:installationId/type` | `{text,frameRevision}` into the focused field |
| `POST /api/agent-computer/:installationId/press` | `{key,frameRevision}`; bounded key allowlist |
| `POST /api/agent-computer/:installationId/decide-write` | `{requestId,approve}`; the person approves or rejects one paused request |
| `POST /api/agent-computer/:installationId/hand-back` | returns control to the agent |

Every route requires the human owner of an active, native installation whose
tool declaration includes `computer_request_takeover`. Ownership failures are
403; stale frames and absent takeover are 409. The person's login text travels
only in their authenticated `type` request; it is not sent to an agent model,
tool argument, or AgentRun. The person performs the final send in this UI.
Each click, type, or press consumes its frame revision before the browser action;
the UI fetches status and frame again before sending another action.
Hand-back aborts pending writes, clears non-cookie storage on every allowed
origin, and replaces the tab at its allowed origin before agent reads resume.
This removes values a site copied into localStorage or IndexedDB as well as
human-entered DOM values and queued page timers. Sites whose login depends on
localStorage may require the person to log in again; the staging walk checks it.

The broker does not use Steel's unauthenticated live-view URL. Forge's
takeover UI calls the PNG and input bridge above. A full live browser walk is
required before enabling a user: LinkedIn may change its controls or depend
on background POSTs that the trial blocks while the agent acts.
