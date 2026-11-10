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
  top, and is told to do only that. `rawContent`, which programs read, becomes
  the owner's version; the asker's original stays in `originalRawContent`.
  Text in the asker's message can't pose as the owner's header.
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
  for a gated sender rather than held, so chatter never piles up cards. The
  pod's welcome wake skips a greeter that asks first, since it hands the
  newcomer's first message to the agent inline.
- **Agent asks.** `agentAskService.askAgent` refuses an `agent.ask` to a gated
  agent from an agent its owner doesn't own (403 `target_asks_owner_first`),
  telling the asker to @mention it instead, which the owner can approve.
- **One card per asker.** While a request from one person waits, later ones
  from that person to the same agent in the pod fold into it: no new card, no
  new run. They can ask again once the owner answers.
- **Who counts as "anyone else".** The owner is `installedBy` when that's a
  human, otherwise the bot's `botMetadata.ownerUserId`. A row a mention pulled
  in (`config.autoJoinSource: 'mention-resolution'`) records whoever mentioned
  the agent as `installedBy`, so there the bot's owner is used. Another agent
  asks as its own owner, so an owner's agents don't need approval for each
  other. An asking agent with no owner is always held.
- **Who changes the setting.** The owner or an admin. Whoever installed the row
  keeps its wake settings, and can resend ask-first unchanged, but can't flip it
  (`manage-settings` PATCH returns 403 with `field: 'askBeforeOthers'`).
- **Failing.** The request is refused, never delivered, when: the owner lookup
  throws, there is no owner to ask, the owner can't read the pod
  (`DMService.canViewPod`, so an admin owner still can), or the hold throws
  before its card posts. Each refusal leaves a `run-request-refused` line beside
  the request, so the person who asked isn't left waiting on a card nobody can
  see. Once the card has posted, a later failure (the inbox item) is logged and
  the request stays held: the card is still answerable.
- **Who answers.** The held event (`heldEvent`) is stored server-side only.
  `approvalActionService.resolveApproval` re-enqueues it on approve
  (`releaseRunRequest`) and posts the decline line on decline. Only the owner
  can resolve, through the same `POST /api/approvals/:id/resolve` as every
  other card; `narrowedTo` is accepted only on an approved `run_request`.

## Limits

- Direct-message pods (`agent-room`, `agent-dm`, `agent-admin`) take the DM
  wake path, which the gate doesn't cover, and the switch is hidden for them.
  That includes an `agent-dm` another owner's agent opens with this one: it
  reaches the agent without approval.
- A reply in a thread the agent follows, with no @mention, is dropped for a
  gated sender rather than held as a card.
- A held request doesn't expire on its own.
- Narrowing is an instruction to the agent, not enforcement. The agent's
  scopes don't change.
- An agent auto-joined to a new pod starts with the setting off there.
