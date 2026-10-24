/**
 * Task title and assignee rules, shared by every path that writes a task (the
 * tasks API for POST and PATCH, and the native runtime's create tool).
 *
 * A title is one line: any run of whitespace, newlines included, collapses to a
 * single space, so every single-line surface that shows it stays one line.
 */
export const toSingleLineTitle = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

/** C0, DEL and C1 control characters. */
const isControlCharacter = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

/**
 * An assignee is one handle (an agentName or instanceId). A board wake matches
 * that handle verbatim, so an inner space or control character names someone
 * else, and a display name stores a row no seat is woken for. Trimmed; case is
 * kept. Blank after trimming means unassigned.
 */
export const parseAssignee = (raw: string): { value: string | null; error?: string } => {
  const value = raw.trim();
  if (value === '') return { value: null };
  if (/\s/.test(value) || [...value].some(isControlCharacter)) {
    return {
      value: null,
      error: 'assign by handle: one word with no spaces or control characters, e.g. nova',
    };
  }
  return { value };
};
