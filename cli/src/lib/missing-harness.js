// F457: what a quick-try run says when the harness it needs isn't on PATH, and
// the report it leaves first. The run exits before it ever checks in, so
// without the report the connect page waits for it forever.

// Only harnesses whose install command we have run ourselves get one here.
const INSTALL = {
  claude: { label: 'Claude Code', command: 'npm i -g @anthropic-ai/claude-code', signIn: 'claude' },
  codex: { label: 'Codex', command: 'npm i -g @openai/codex', signIn: 'codex' },
};

/** One sentence on how to get the named harness, ending with "run this line again". */
export const missingHarnessHint = (name) => {
  const known = INSTALL[name];
  if (!known) return `Install ${name}, then run this line again.`;
  return `Install ${known.label} (${known.command}), sign in once by running ${known.signIn}, then run this line again.`;
};

/**
 * Tell the instance what this run looked for (a harness id, or null for none
 * of the ones it probes). Best effort: an older instance without the route, or
 * a failed call, must not hide the message the person needs in the terminal.
 */
export const reportMissingHarness = async (client, harness) => {
  try {
    await client?.post?.('/api/agents/runtime/harness-missing', { harness });
  } catch {
    // The terminal message below is the answer either way.
  }
};
