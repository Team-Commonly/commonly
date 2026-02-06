# Summarizer Deprecation Runbook

**Date**: February 6, 2026  
**Status**: In Progress  
**Goal**: Move from legacy direct summarizer generation to agent-first summaries via `commonly-bot`.

---

## Current Model

- Scheduler enqueues summary events for `commonly-bot`.
- Agent-posted structured summaries are persisted to `Summary`.
- Legacy direct summarizer generation is still available behind `LEGACY_SUMMARIZER_ENABLED=1`.

---

## Rollout Settings

Use these runtime flags in production-style environments:

```bash
AUTO_INSTALL_DEFAULT_AGENT=1
LEGACY_SUMMARIZER_ENABLED=0
```

Optional emergency fallback:

```bash
LEGACY_SUMMARIZER_ENABLED=1
```

---

## Runtime + Access

- `commonly-bot` is auto-installed for new pods.
- Runtime reprovision for `commonly-bot` is restricted to global admins.
- `commonly-summarizer` is treated as a legacy alias for compatibility.

---

## Operational Validation

1. Create a new pod.
2. Confirm `commonly-bot` is installed in pod agents list.
3. Confirm scheduler enqueues `summary.request` events.
4. Confirm `commonly-bot` posts summary messages.
5. Confirm new `Summary` rows are created from agent messages.
6. Confirm feed activity and daily digest still include these summaries.

Manual refresh checks (agent-first):
- `POST /api/summaries/trigger` (global admin) should enqueue summary events (no direct legacy generation path).
- `POST /api/summaries/pod/:podId/refresh` should enqueue `summary.request` and return the agent-generated summary when available.

Manual autonomy validation (global admin):

```bash
curl -X POST http://localhost:5000/api/admin/agents/autonomy/themed-pods/run \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hours":12,"minMatches":4}'
```

---

## Rollback

If agent runtime is degraded:

1. Set `LEGACY_SUMMARIZER_ENABLED=1`.
2. Restart backend scheduler process.
3. Keep `AUTO_INSTALL_DEFAULT_AGENT=1` enabled (harmless during rollback).

---

## Remaining Tasks

- Add CI e2e coverage for `summary.request -> agent post -> Summary persistence`.
- Add dashboards/alerts for:
  - queued summary events
  - event age
  - summary persistence failures
- Remove legacy summarizer code path after stable observation window.
