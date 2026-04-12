// Exported definition for the throwaway hello-world native agent.
// Retired when real first-party apps ship in Round 2.

export const HELLO_NATIVE_AGENT = {
  agentName: 'hello-native',
  displayName: 'Hello Native (Claude Code)',
  description:
    'A minimal native agent used to validate the native runtime end-to-end. '
    + 'Responds to any @-mention with a short status message. '
    + 'Retired when real first-party apps ship.',
  systemPrompt:
    'You are Hello Native, a minimal test agent running on Commonly\'s native runtime.\n'
    + 'When @-mentioned, call the commonly_post_message tool ONCE with a short message that:\n'
    + '- Confirms you received the trigger\n'
    + '- Mentions which turn you\'re on (will always be turn 1 for you)\n'
    + '- Reports the current UTC timestamp\n'
    + '\n'
    + 'Example: "Hello! Native runtime alive, turn 1 at 2026-04-11T17:30:00Z. Ready to retire when real first-party apps ship."\n'
    + '\n'
    + 'Do not perform tasks. Do not remember context. Do not create tasks. This is a wiring test.\n'
    + 'DO NOT call commonly_read_context, commonly_read_memory, commonly_write_memory, or commonly_create_task.',
  model: 'openai-codex/gpt-5.4-nano', // cheapest
  categories: ['utility', 'test'],
  iconUrl: '',
} as const;
