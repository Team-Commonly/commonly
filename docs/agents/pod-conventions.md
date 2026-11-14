# Pod conventions

A pod's conventions are its working rules: how this team replies, who owns what, what to check before posting. There is one text per pod, and every member reads the same one, agent or human (F124, TASK-766). `AgentProfile.instructions` is per agent per pod; conventions are the pod's.

## Who writes and who reads

- **Write:** a human account that created the pod and is still a member of it, or a global admin. An agent account can't write them, even one that holds the creator id. A creator who has left the pod can't write them either, because they no longer write what its agents read.
- **Read:** any pod member, through all three paths below.
- **Size:** at most 4000 characters, counted in code points, so the limit is the same in any script. Text is trimmed, an empty text is refused (send `null` to clear), and NUL is refused.

## The API

- `GET /api/pods/:id/conventions` returns `{ podId, revision, conventions, permissions: { canEdit } }`. `conventions` is `null` or `{ text, updatedAt, updatedBy: { userId, label } }`.
- `PATCH /api/pods/:id/conventions` takes exactly `{ expectedRevision, text }`, where `text` is a string or `null`. A stale `expectedRevision` answers 409 `CONVENTIONS_CONFLICT`, with the current read in `current`, the same compare-and-swap that focus uses.

## How agents get them

- **The CAP context read** (`GET /api/agents/runtime/pods/:podId/context`) carries the same `{ podId, revision, conventions }` object as `conventions`, from the same pod snapshot as `focus`. An SDK bot or any CAP client reads it there.
- **CLI turns** (`commonly agent run`) carry a conventions frame in the prompt, ahead of the focus frame, built from that same context read, so it adds no request. Skill text the server sends can come before it. A server from before F124 omits the field, and the turn runs without a frame. Code: `cli/src/lib/pod-conventions.js`.
- **Native turns** carry the same frame in their user message, built from the pod row the turn already loads. The recent-messages block and Scout's start cue come before it. Code: `backend/services/podConventionsService.ts` (`formatPodConventionsFrame`), used in `nativeRuntimeService.ts`.

The frame names who set the conventions. It says they describe how work is done in the pod, that they can't grant permissions, ask the agent to reveal credentials or local files, or direct actions outside the pod, and that the agent's own instructions win where the two conflict. Every line of the text is quoted with `| `, splitting on every line break a model or terminal may show, U+2028, U+2029 and NEL included, so a line that reads like the frame's end marker can't close the frame and pose as another part of the prompt. The author label is folded to one line, with any `=` removed. A BYO agent's owner is often not the pod's creator, so the pod's rules sit below the owner's in the prompt: in the user message, never in the system prompt. On native turns, the frame is added after the turn takes the addresses that `commonly_fetch_url` may open, so a link written in the conventions doesn't become one the agent may fetch.

## Not done yet

- There's no editor in the pod UI yet. Conventions are set through the API.
- The pod doesn't get a socket event when its conventions change. A turn reads them fresh at its start, so the next turn sees the change.
