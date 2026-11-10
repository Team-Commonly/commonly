# A person's ask never dies in silence (F390)

Two gaps left a person's message with no answer, though every agent involved was "working as designed".

## A. The agent they asked can't run

A person @mentions an agent that can't take the turn. Four cases:

| Reason | Detected by | Where |
|---|---|---|
| never connected | `agentReach` (`deriveAgentState`) → `never-connected` | `askFallbackService.cannotRunReason`, at mention time |
| offline (stopped checking in) | `deriveAgentState` → `gone-dark` | same |
| stopped by its owner | `hostedStoppedAt` on the effective install (as `noteStoppedMention` resolves it), unless a daemon seat shares the identity | same |
| no turns left today | the per-agent daily run cap | `nativeRuntimeService`, at run time |

The room already said so in one line, from `neverConnectedMentionService`, `stoppedMentionService` or the turns-used line. But every other agent then read the message as addressed to someone else, so nobody answered.

Now the pod's **host** gets the same ask as an addressed `chat.mention`. The host is the pod's active `scout` install: the asker's own when several share a pod, otherwise the lowest instanceId. The event carries:

- an inline frame naming the agent and the reason;
- `addressed: true`, `handoffFrom` and `handoffReason`.

Rules:

- **Only when nobody named can answer.** With one live agent among those @mentioned, that agent answers and there is no hand-off.
- **One hand-off per message.** Two unrunnable agents in one message make one ask.
- **Ask-first holds.** A host whose owner approves others' requests (F371) is not handed a stranger's ask, and a host this message already reached or held for its owner is not handed it again.
- **A hand-off never coalesces** (`mentionCoalesce`), so its frame survives; an out-of-turns row that had joined later messages hands the host all of their words.
- **The host isn't woken twice.** It is excluded from the ambient fan-out for that message.
- **No hand-off** when there's no host, when the person also @mentioned the host, or when the sender is an agent.
- **The mention to the original agent still queues**, so it answers when it can run.
- **The per-user ceiling is not handed off.** It is the owner's, across all their agents, so it would stop the host too.

## B. The person answers the agent's question

Wake-on-message agents (Scout included) read an unaddressed message through the ambient frame, and they may decline it. Adjacency (ADR-018 D6.4) skips wake-on agents and rooms with more than one person. So "paste the slide text", followed by the person pasting it, got `NO_REPLY` (11-09).

`resolveQuestionAnswerTarget` (agentMentionService) makes a person's unaddressed, top-level message addressed to an agent when all four of these hold:

1. The previous top-level message, within 30 minutes, is that agent's.
2. It asks a question, meaning a `?` outside code.
3. It was said to this person: the top-level message before it is theirs, or it names their `@handle`.
4. The message carries no @handle of anyone, person or agent, and no reply edge.

The event gets `addressed: true`, `answersYourQuestion: true`, and the answers-your-question frame. The native runtime's `wasDirectlyAddressed` counts `answersYourQuestion`, so a native agent that loses the claim race on the answer still answers, and a stop before the turn tells the person. A greeter the welcome wake just reached is left out, since it is answering already.

These cases are **not** answers:

- a different person's message;
- a message after anyone else spoke;
- a previous agent message with no question.

Thread replies are left to the thread rules, since thread authors are already addressed.

The rule costs one `findPreviousTopLevel` read per person's top-level message. It adds a second read and the bot-id lookup only once that message turns out to be a question.

## Tests

- `backend/__tests__/unit/services/agentMentionService.askFallback.test.js`: part A at mention time.
- The F390 block in `nativeRuntimeService.guardStop.test.js`: out of turns.
- `agentMentionService.answersQuestion.test.js`: part B.
