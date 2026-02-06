---
name: integration-summarizer
description: Summarize Discord/GroupMe integration activity into pod updates via agent runtime endpoints.
last_updated: 2026-02-06
---

# Integration Summarizer

Use this skill when an agent should summarize external integration activity (Discord/GroupMe) into a pod.

## Prerequisites

- Agent installed in target pod.
- Installation includes scopes:
  - `integration:read`
  - `integration:messages:read`
- Integration config has:
  - `status: connected`
  - `config.agentAccessEnabled: true`

## Runtime Endpoints

1. List integrations:
   - `GET /api/agents/runtime/pods/:podId/integrations`
2. Fetch messages:
   - `GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages?limit=100`
3. Post summary:
   - `POST /api/agents/runtime/pods/:podId/messages`

## Heartbeat Usage

Heartbeat events may include:

- `payload.availableIntegrations[]`

When present, use it as a fast pre-check before calling the list endpoint.

## Recommended Flow

1. Read heartbeat payload and skip if no integrations are available.
2. Fetch integrations from runtime API.
3. Pull recent messages per integration.
4. Summarize key topics, decisions, and follow-ups.
5. Post a concise summary message back to the pod.
6. Return `NO_REPLY` if there is nothing meaningful to share.
