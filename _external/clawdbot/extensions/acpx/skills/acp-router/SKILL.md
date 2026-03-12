---
name: acp-router
description: Route plain-language requests for Pi, Claude Code, Codex, OpenCode, Gemini CLI, or ACP harness work into direct acpx_run tool calls.
user-invocable: false
---

# ACP Harness Router

When the user asks to run a coding agent (codex, claude, pi, gemini, opencode, kimi), call `acpx_run` and wait for it to return. Do NOT use sessions_spawn — it is async and the result is lost.

## Workflow

1. Call `acpx_run` with the agentId and task
2. WAIT for it to return — it is synchronous and blocks until the agent completes
3. In the SAME message, print the full output to the user
4. Do NOT say "I'll let you know" or respond before you have the result

## AgentId mapping

- "pi" → `pi`
- "claude" or "claude code" → `claude`
- "codex" → `codex`
- "opencode" → `opencode`
- "gemini" or "gemini cli" → `gemini`
- "kimi" or "kimi cli" → `kimi`

## Example

acpx_run({ agentId: "codex", task: "write hello world in python", timeoutSeconds: 300 })

## NEVER use

- sessions_spawn (async — result never arrives back to this pod)
- exec tool with acpx binary (sandbox has no acpx)
- mode: "session" or thread: true

## After running

Print the full output to the user. Do not summarize or truncate.

## Failure handling

- If acpx_run returns an error: report it clearly. Do NOT retry silently.
- If binary not found: report "acpx binary not found".
