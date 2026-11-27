# OpenCode over ACP: permission requests are up to the agent

The Agent Client Protocol (ACP) lets an agent ask its client before it runs a tool, by sending `session/request_permission`. We expected a client could rely on that to keep a seat from editing files or running commands. A walk with OpenCode shows the agent decides whether to ask at all.

## What was walked

- **Agent:** OpenCode v2.4.0, the `opencode-darwin-arm64.zip` release asset. Its SHA-256 matched the release's `SHA256SUMS`.
- **Where:** macOS arm64, on 2026-11-26.
- **Client:** Commonly's ACP adapter from the open adapter PRs, starting at #4396.
- **Isolation:** the CLI ran under a scratch HOME. The Commonly backend and the model were both local stubs on 127.0.0.1.
- **Model:** OpenCode used an OpenAI-compatible provider pointed at the model stub. In the permission runs, the stub first called OpenCode's `write` tool (ACP kind `edit`) or its `shell` tool (kind `execute`).

## What happened

**With OpenCode's default config, it asked nothing.** It ran `write` and `shell` without sending `session/request_permission`. The file was written and the command ran, even though the seat's policy would have rejected both. A client's permission policy only answers the requests an agent chooses to send.

**With `"permission": { "edit": "ask", "bash": "ask" }` in OpenCode's config, it asked every time:**
- Each call sent `session/request_permission` with the tool kind (`edit` or `execute`) and the options `allow_once`, `allow_always` and `reject_once`.
- When the client answered `reject_once`, the file was not written and the command did not run. OpenCode then ended the prompt with stopReason `cancelled`.
- When the client answered `allow_once` to an `edit`, the file was written and the prompt ended with `end_turn`.

## Not walked

- **Web fetches.** OpenCode's [permissions page](https://opencode.ai/docs/permissions/) says every agent "starts with this ordered base policy". The first rule of that policy is `{ "action": "*", "resource": "*", "effect": "allow" }`, and `webfetch` has no rule of its own, so a web fetch runs without asking. To have it ask, add `webfetch` to the actions that ask.
- **The V2 config form.** The same page says "In V2, use `permissions`, `shell`, and `subagent` instead of `permission`, `bash`, and `task`", with rules such as `{ "action": "shell", "resource": "*", "effect": "ask" }` in a `permissions` array. The walk used the older form above, which v2.4.0 honoured for `edit` and `shell`.
- **Other ACP agents.** `gemini`, `goose` and `qwen` haven't been walked.

## What this means for a seat

An ACP agent can skip its permission requests, so a seat's policy holds only as far as the agent is set up to ask. Configure the agent itself to ask, on the computer that runs it, for every tool kind the seat's policy would refuse or would hold for the owner's approval. A tool the agent runs without asking skips the approval rule too. The protocol can't stop an agent that doesn't ask. Anything stronger has to come from outside the agent's process, and this walk didn't test any such confinement.
