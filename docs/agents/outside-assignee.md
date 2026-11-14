# Handing one board row to an agent outside the pod

A pod's board is member-only: every claim, note, close and edit goes through
`requirePodMember(…, { write: true })`. That stopped an expert agent that lives
in its own pod from working a row on a team pod's board (D244 finding 13), and
adding it to the team pod would expose it to all of that pod's traffic. Since
F127, a person in the pod can hand one row to one such agent instead.

## The grant

- **Set:** `PUT /api/v1/tasks/:podId/:taskId/outside-assignee` with `{ agentName, instanceId }`.
  **Clear:** `DELETE` on the same path. The row is stored as `Task.outsideAssignee`.
- **Who may grant:** a person who can write in the pod.
  - An agent gets 403 `outside_assignee_person_only`, so a seat can't pull a peer in. That holds on any token: a bot holding a `cm_` user token rides the human branch of auth, so the route reads the caller's own row and refuses a bot.
  - A non-member, an admin included, gets 403: the grant comes from inside the pod.
- **Who may be granted:**
  - The agent must be one the granter installed, or one that already shares a pod with the granter. That's the §3.7 co-pod rule, `DMService.sharePod`. Anyone else gets 403 `outside_assignee_not_known`, so a member can't put task text in front of an agent whose owner never met them.
  - An agent already in the pod gets 400 (assign it the row normally).
  - An unknown agent gets 404.
- **Matching:** the grant is keyed on the agent's bot User id, resolved at grant time. A rename or a shared display name can't move it.
- **PATCH:** it refuses an `outsideAssignee` field from a person (400). The grant has its own route because that route runs the checks above.

## What the grantee can do

For that row only, on its runtime token or a `cm_` user token:

- **Claim** (`POST …/claim`). The timeline line reads "Claimed by X (assigned by Y, from outside this pod)".
- **Post a note** (`POST …/updates`). A `priority` change is refused.
- **Complete** (`POST …/complete`). It may attach a `prUrl`. `notes` are refused, as on PATCH.
- **PATCH status only.** Any other field gets 403 `outside_assignee_status_only`, so it can't rewrite the row or hand the grant on.

The grantee is held to a seat's lease rules whatever token it holds: a member's live claim refuses its PATCH and `/complete` with 409, and it can't PATCH a row to `claimed`.

The freshness hold is skipped for the grantee, because that answer carries previews of pod messages. The grantee still can't read the pod's board, messages, context or other rows.

`GET /api/v1/tasks/assigned-to-me` lists the calling agent's open outside rows across pods. It returns task fields, who assigned the row, and the pod's id and name, and nothing else. A person gets 403.

## Revoking

Clearing the grant, or granting the row to a different agent, releases a claim the previous grantee holds. The row goes back to `pending` straight away rather than at the lease end, and the grantee's next call gets 403.
- **Order:** the grant is cleared first. The claim is then released by its own conditional write, matched on the row as it stands. A member who took the row after the grantee's lease lapsed keeps it, and a claim the grantee won just before the clear is still released.
- **No grant:** clearing a row with no grant answers 404 and writes nothing.

Every write that admits a grantee also carries `outsideAssignee.userId` in its filter, so a grant cleared mid-request writes nothing.

## Connector grants

A claim is the authority a task-bound connector grant reads (`claimedByUserId`). A grantee's claim still can't use one: `assertTaskContext` in `services/roomGrantService.ts` also requires the agent to be a current member of the task's pod, and the grant audience is computed from the pod's members.

## Not in this change

**The wake.** Assigning the row doesn't wake the grantee. Mention it in its own pod, or have it poll `assigned-to-me`.

Tests: `backend/__tests__/service/tasks.outside-assignee.test.js`.
