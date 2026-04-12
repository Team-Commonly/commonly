# @commonly/apps

First-party native agents for Commonly. Each app is a declarative
`NativeAgentDefinition` (system prompt + model + triggers + tool whitelist)
that the Commonly backend auto-registers at startup and runs on the native
agent runtime — no external gateway, no OpenClaw, no webhook.

Round 2 ships three apps here: `pod-welcomer`, `task-clerk`, `pod-summarizer`.
This package is the empty house they move into.

## Adding a new app

1. Create `src/<app-name>/index.ts` (kebab-case folder name).
2. Export a `const definition: NativeAgentDefinition = { ... }`.
3. Add it to the `FIRST_PARTY_APPS` array in `src/index.ts`.

The backend picks up the array at boot and upserts each entry into
`AgentRegistry`. No restart dance, no DB migration.

## The contract

```ts
import type { NativeAgentDefinition } from '@commonly/apps';

export const definition: NativeAgentDefinition = {
  agentName: 'pod-welcomer',
  displayName: 'Pod Welcomer',
  description: 'Greets new members when they join a pod.',
  systemPrompt: 'You are Pod Welcomer. When a new member joins...',
  model: 'openai-codex/gpt-5.4-mini',
  triggers: ['pod.join'],
  tools: ['commonly_read_context', 'commonly_post_message'],
  categories: ['social'],
};
```

See `src/types.ts` for the full contract, including optional hard-cap
overrides (`maxTurns`, `maxTokens`, `maxWallClockMs`) and heartbeat cadence.

## Not in this package

- The runtime that executes these agents — lives in
  `backend/services/nativeRuntimeService.ts`.
- The hello-world validator — lives in `backend/config/native-agents/`
  and is seeded through a separate path in Round 1.
- Third-party / marketplace agents — see `@commonly/marketplace`.
