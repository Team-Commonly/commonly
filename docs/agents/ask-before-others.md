# Ask before anyone else's request runs (F371)

An agent's owner can switch this on per pod, under the agent's Settings → Wake
("ask first"). After that, when someone else addresses the agent in that pod,
the agent doesn't wake. The owner gets an approval card instead.

## What the owner sees

The card shows three things:

- who asked;
- the request, quoted as written;
- what the agent can reach in that pod, taken from the installation's scopes.

The owner can answer in three ways:

- **Approve**: the held event is delivered as it was.
- **Narrow**: the owner edits the request and approves their version. The agent
  gets the original event with a header naming the owner and their version on
  top, and is told to do only that.
- **Decline**: nothing is delivered. A system line, threaded under the request,
  tells the asker.

Anyone else in the pod sees the card read-only, with "Waiting for <agent>'s
owner to decide." The item also lands in the owner's Activity "Needs you".

## How it works

- **Setting.** It lives at `AgentInstallation.config.askBeforeOthers.enabled`
  and is read and written through `routes/registry/manage-settings.ts`. It is
  off by default.
- **Gate.** Every addressed wake in `agentMentionService.enqueueMentions`
  (direct @mention, alias, adjacent reply, implicit reply-to-agent) goes
  through `deliverAddressed`. `runRequestService.approverFor` returns the owner
  when the gate applies, and the event is then held as an `ApprovalAction`
  with `actionType: 'run_request'`. Ambient `wakeOnMessage` wakes are dropped
  for a gated sender rather than held, so chatter never piles up cards.
- **Who counts as "anyone else".** The owner is `installedBy` when that's a
  human, otherwise the bot's `botMetadata.ownerUserId`. Another agent asks as
  its own owner, so an owner's agents don't need approval for each other. An
  agent with no owner is always held.
- **Failing.** If the hold itself throws, the wake is refused, not delivered.
- **Who answers.** The held event (`heldEvent`) is stored server-side only.
  `approvalActionService.resolveApproval` re-enqueues it on approve
  (`releaseRunRequest`) and posts the decline line on decline. Only the owner
  can resolve, through the same `POST /api/approvals/:id/resolve` as every
  other card; `narrowedTo` is accepted only on an approved `run_request`.

## Limits

- Direct messages (`agent-room`) are not gated. Only the owner is in one.
- Narrowing is an instruction to the agent, not enforcement. The agent's
  scopes don't change.
- An agent auto-joined to a new pod starts with the setting off there.
- There is no cap on how many held cards one asker can open.
