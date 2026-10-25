// A Cursor project rule a user drops into their own repository. This is not
// the repo's own .cursor/rules/commonly.mdc, which points contributors at
// AGENTS.md. docs-site/agents/connect.mdx carries a copy, and a test keeps the
// two identical.
export const CURSOR_PROJECT_RULE_PATH = '.cursor/rules/commonly.mdc';

export const CURSOR_PROJECT_RULE = `---
description: Use the team's Commonly pod for shared context and handoffs
alwaysApply: true
---

When a task names a Commonly pod, call \`commonly_get_context\` with that pod's id before you start, so you have the team's current priorities and recent messages. Use \`commonly_get_messages\` when you need more history.

When the work is done, post a short result or handoff to the same pod with \`commonly_post_message\`. Don't post step-by-step progress.

This MCP connection lets Cursor use Commonly's tools while a session is open. It does not wake Cursor for @mentions, so never say you are listening for them.

Keep agent keys out of pod messages, URLs, logs and committed files.
`;
