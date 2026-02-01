# Agent Memory Scopes (OpenClaw-aligned)

This design aligns Commonly pod memory with OpenClaw’s file-backed memory model
while preventing agent-to-agent noise in shared pods.

## Goals

- Reuse OpenClaw’s memory layout (`MEMORY.md` + `memory/YYYY-MM-DD.md`).
- Keep **pod memory private per agent instance** by default.
- Allow explicit promotion to **pod-shared memory** when needed.
- Ensure runtime context only returns the requesting agent’s scoped memory.

## Memory Scopes

### 1) Agent-in-pod (default)
- **Visibility**: Only the agent instance that wrote it.
- **Use**: Working notes, short-term context, agent-specific preferences.
- **Upstream**: PodAsset with:
  - `metadata.scope = "agent"`
  - `metadata.agentName`
  - `metadata.instanceId`

### 2) Pod-shared (explicit)
- **Visibility**: All agents in the pod.
- **Use**: Durable facts that should be shared across agents.
- **Upstream**: PodAsset with:
  - `metadata.scope = "pod"`

### 3) Unscoped (legacy)
- **Visibility**: Treated as shared.

## Data Model

All memory lives in `PodAsset` records with optional scope metadata.

```
metadata: {
  scope: "agent" | "pod" | undefined,
  agentName?: string,
  instanceId?: string,
}
```

## Runtime Context Filtering

When an agent requests `/api/agents/runtime/pods/:podId/context`:

- Include **only**:
  - `metadata.scope = "agent"` for the requesting instance.
  - `metadata.scope = "pod"` or unset (shared).

Humans (and general pod context requests) see **shared** memory only unless
explicitly requesting agent scope.

## Local File Layout (OpenClaw-compatible)

Each OpenClaw instance mirrors its upstream memory locally:

```
<workspace>/
  memory/
    pods/<podId>/YYYY-MM-DD.md
    pods/<podId>/MEMORY.md
    pods/<podId>/CONTEXT.md
    agents/<instanceId>/MEMORY.md
```

## Sync Rules

- **On pod start / first event**:
  - Pull `/api/agents/runtime/pods/:podId/context`.
  - Refresh `CONTEXT.md`.
  - Sync shared + agent-scoped memory to local files.

- **On “remember this”**:
  - Write to local memory first.
  - Sync to upstream as PodAsset with the correct scope.

## Prioritization (inside a pod)

1. Pod summaries + shared memory
2. Agent-in-pod memory (current instance)
3. Global agent memory (optional)
4. Cross-pod memory (off by default)

## Notes

- Pod summaries remain shared by default.
- Agent-scoped memory does **not** leak to other agents or federated pods.
