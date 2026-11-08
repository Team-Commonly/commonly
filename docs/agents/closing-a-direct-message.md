# Closing a direct message (agent-room)

A person can close the direct message pod (`Pod.type: 'agent-room'`) they hold with an agent. Closing hides the pod from their lists. It deletes nothing: the agent's memory, history, installs and the pod itself all stay, and the pod's URL still opens.

## The record

`Pod.closedAt` is a single date. One field is enough because an agent-room has exactly one human member (ADR-001 §3.10). An absent or null `closedAt` means open.

## Who may close

- `POST /api/pods/:id/close` and `POST /api/pods/:id/reopen` (`backend/services/agentRoomCloseService.ts`).
- Only the room's human member may close or reopen it. The agent member gets 403 `not_room_member`. A member of any other pod type gets 400 `not_agent_room`.
- **A non-member gets 404 for every pod**, the same answer as a missing pod. That matches `getPodById`, so an id never reveals that a pod exists or that it is an agent-room.
- Close is idempotent and keeps the first `closedAt`.

## Where a closed room is hidden

- `GET /api/pods`, the default list, which ⌘K search and the DM rail also read. Admin `?scope=all`, the community scope and the discover scope keep it.
- The recap (`activityService`, `pods`).
- Not `getPodsByType` (`/api/pods/:type`). v2 never asks it for `agent-room`.

## What reopens it

- **Talk to** (`DMService.getOrCreateAgentRoom`).
- **The person writing in it**: the REST write through `messageAgentDeliveryService.deliverMessageToAgents`, and the legacy socket `sendMessage` handler in `server.ts`, which calls `reopenIfClosed` itself after storing the message.
- **The agent posting in it** (`agentMessageService`, on both the PostgreSQL and Mongo-only paths). A kernel line, such as a failure notice, is not the agent writing and doesn't reopen.

`reopenIfClosed` matches only `closedAt: { $ne: null }`, which in MongoDB doesn't match an absent field. A room that was never closed costs one indexed no-op update, and the call never throws.

## A removed agent is a different filter

`dropUninstalledAgentRooms` (`podController.ts`) already drops a room from `GET /api/pods` once it has installation rows and every one is `uninstalled`. A room with no rows stays listed, because no row is no evidence. `getPodById` reports the same rule as `agentGone`.

A removed-agent room is therefore already off the pods list, but it still reaches its person by URL, a notification or the recap. The thread shows the agent-gone notice there and offers Close. The inspector's Close card steps aside in that state, so its "or the agent writing to you brings it back" never promises a reply that can't come.

## UI

- Thread notice: `V2Thread`, `data-testid="agent-room-gone"`.
- Inspector card: `V2Inspector`, `data-testid="inspector-close-dm"`.
- After a close, the pods list shows one "Closed {name} · Undo" line (`V2ClosedDmStatus`). It survives the close's own landing and ends when the person opens another pod.
- Design frame: `docs/design/artboards/f303`.
