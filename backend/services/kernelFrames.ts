/**
 * The frames the kernel writes ahead of a mention's text
 * (agentMentionService.buildContentForTarget): one line each, opened by `[`
 * (most by `[<tag>:`) and closed by `]`, joined by newlines, then a blank
 * line, then the message itself.
 *
 * They are written once for every runtime, and several name tools that only
 * some runtimes have: the pod frame teaches file attach/read and threading
 * fields, and the two collaboration cues teach a DM tool. A driver that knows
 * its own tool list exactly (the native runtime) rewrites the frames it cannot
 * honour instead of leaving the model to claim tools it was never given. It
 * finds them by tag, here. agentMentionService writes the same tags as
 * literals (verify-moltbot-tool-contract reads them there); kernelFrames.test
 * pins each tag below to its literal, so the two cannot drift apart silently.
 */
export const KERNEL_FRAME_TAGS = Object.freeze({
  podContext: 'Pod context',
  trigger: 'Trigger',
  consultation: 'Collaboration',
  collaborativePod: 'Collaborative pod',
  replyMechanics: 'Reply mechanics',
  wakeOnMessage: 'Wake-on-message',
} as const);

const FRAME_TAG = /^\[([A-Za-z][A-Za-z -]*):/;

/** The tag a frame line opens with, or null for a line that is not a frame. */
export const frameTagOf = (line: string): string | null => {
  const match = FRAME_TAG.exec(String(line || ''));
  return match ? match[1] : null;
};

/**
 * The leading kernel frames of `content` and the text after them. Content that
 * does not open with a block of frame lines comes back whole as the body, so a
 * caller can always rejoin what it was given.
 */
export const splitKernelFrames = (content: string): { frames: string[]; body: string } => {
  const text = String(content || '');
  const end = text.indexOf('\n\n');
  if (!text.startsWith('[') || end === -1) return { frames: [], body: text };
  const lines = text.slice(0, end).split('\n');
  // Some frames carry no tag (the replies-to-you cue opens "[This message…").
  // They are still frames; a caller rewrites only the tags it knows.
  const allFrames = lines.every((line) => line.startsWith('[') && line.trimEnd().endsWith(']'));
  if (!allFrames) return { frames: [], body: text };
  return { frames: lines, body: text.slice(end + 2) };
};

/** The inverse of splitKernelFrames. */
export const joinKernelFrames = (frames: readonly string[], body: string): string => (
  frames.length ? `${frames.join('\n')}\n\n${body}` : body
);
