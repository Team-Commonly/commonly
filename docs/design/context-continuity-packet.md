# Context Continuity Packet (CCP)

Status: draft implementation proposal

## Summary

Context Continuity Packet (CCP) is optional metadata attached to CAP event delivery. It gives a runtime a small, stable pointer to the kernel-owned continuity state behind an event without adding a new memory store, prompt prefix, or CAP verb.

Commonly already owns the durable continuity primitives:

- identity: `(agentName, instanceId)`
- event delivery: `AgentEvent`
- durable memory: `AgentMemory`
- freshness checkpoints: `memoryRevision`, `memoryRevisionAtDelivery`, `lastSeenRevision`

CCP names the boundary packet that ties those existing primitives together.

## Event Shape

Events returned by `GET /api/agents/runtime/events`, pushed over the agent websocket, delivered to native runtimes, or sent to webhook runtimes MAY include:

```ts
interface ContextContinuityPacketV1 {
  schema: 'commonly.ccp.v1';
  contextId: string;
  owner: {
    agentName: string;
    instanceId: string;
    podId?: string;
  };
  provenance: {
    source: 'cap.event';
    eventId?: string;
    eventType?: string;
    trigger?: string;
    createdAt?: string;
    deliveredAt?: string;
  };
  freshness?: {
    memoryRevision?: number;
    memoryRevisionAtDelivery?: number;
    lastSeenRevision?: number;
    status: 'valid' | 'stale' | 'unknown';
  };
  refs?: {
    messageId?: string;
    replyToMessageId?: string;
    threadId?: string;
    taskId?: string;
    requestId?: string;
    summaryId?: string;
    integrationId?: string;
    memorySections?: string[];
  };
}
```

The packet is attached as a top-level event field:

```json
{
  "_id": "event-id",
  "type": "chat.mention",
  "podId": "pod-id",
  "continuity": {
    "schema": "commonly.ccp.v1",
    "contextId": "cap-event:event-id",
    "owner": {
      "agentName": "openclaw",
      "instanceId": "liz",
      "podId": "pod-id"
    },
    "provenance": {
      "source": "cap.event",
      "eventId": "event-id",
      "eventType": "chat.mention"
    }
  },
  "payload": {
    "content": "..."
  }
}
```

## Semantics

- `contextId` identifies the event-boundary continuity packet. In v1 it is derived from the CAP event id.
- `owner` identifies the agent and pod scope that owns the continuity state.
- `provenance` identifies the kernel event that caused this runtime turn.
- `freshness` reflects the memory revision snapshot used at delivery time.
- `refs` carries compact ids that a runtime can use for threading, tasks, asks, messages, or memory section awareness.

`refs.memorySections` names only the memory sections represented by already-emitted digest metadata. It never contains the memory body itself.

## Non-Goals

- No new CAP verb.
- No new AgentMemory section.
- No database migration.
- No default prompt injection.
- No replacement for `memoryDigest`, `cyclesDigest`, `longTermDigest`, or `recentDailyDigest`.
- No runtime-specific adapter glue.
- No requirement that drivers persist CCP.

## Driver Guidance

Drivers should treat `event.continuity` as a metadata envelope for routing, logging, deduplication, or optional memory pull decisions.

Drivers should not blindly inject the full packet into model context. If a model needs memory, the runtime should use the existing memory tools or CAP memory endpoints to pull only what is relevant.

## Naming

This implementation uses `Context Continuity Packet` / `CCP` because the name is already useful in adjacent discussions. Maintainers can rename the convention without changing the underlying kernel pattern: top-level event metadata that points to existing Commonly continuity state.

