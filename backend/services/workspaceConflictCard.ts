/**
 * TASK-597 (D155, ADR-008): a workspace merge that conflicts becomes a decision
 * request, not a failed turn.
 *
 * A LayerFS `branch.merge` refuses atomically on a conflict: nothing is created
 * and main is unchanged (Stack's L14 §10). That refusal is the card payload. The
 * agent raises it, a person picks a side or writes the merged text, and the
 * merge runs again. This module only shapes the request; the driver that calls
 * branch.merge is not wired yet.
 *
 * Every field is clipped to the limits decisionRequestService enforces, so a
 * request this module builds is accepted at the door.
 */
import type { DecisionClass } from './decisionRequestService';

// The Conflict shape LayerFS 582bc786f9 returns. A refused merge carries
// `detail.conflicts[]`, one entry per file. A content conflict has `hunks`, with
// the line and both sides as arrays of lines. A binary or modify/delete
// conflict, such as /.git/index, has no hunks.
export interface WorkspaceMergeHunk {
  line: number;
  ours: string[];
  theirs: string[];
}

export interface WorkspaceMergeConflict {
  path: string;
  kind: string;
  blocks?: number;
  hunksOmitted?: boolean;
  hunks: WorkspaceMergeHunk[];
}

export interface WorkspaceConflictRequest {
  title: string;
  question: string;
  context: string;
  decisionClass: DecisionClass;
  options: Array<{ label: string; description?: string }>;
}

// decisionRequestService limits (title 160, question 1000, context 2000,
// option label 80, option description 280).
const TITLE_MAX = 160;
const QUESTION_MAX = 1000;
const CONTEXT_MAX = 2000;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 280;
const SIDE_CLIP = 200;
const TITLE_PREFIX = 'Merge conflict in ';

const clip = (text: string, limit: number): string => (
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text
);

const sideText = (lines: string[]): string => clip(lines.join('\n').trim() || '(empty)', SIDE_CLIP);

const hunkBlock = (hunk: WorkspaceMergeHunk, sides: { base: string; branch: string }): string => (
  `line ${hunk.line}\n${sides.base}: ${sideText(hunk.ours)}\n${sides.branch}: ${sideText(hunk.theirs)}`
);

const contextFor = (conflict: WorkspaceMergeConflict, sides: { base: string; branch: string }): string => {
  const header = [`Conflict kind: ${conflict.kind}`];
  if (conflict.blocks !== undefined) header.push(`Conflict blocks: ${conflict.blocks}`);
  if (conflict.hunks.length === 0 && !conflict.hunksOmitted) header.push('No line-level hunks: the two sides differ as a whole.');
  if (conflict.hunksOmitted) header.push('Some hunks were omitted by the merge.');
  const parts = [header.join('\n')];
  let used = parts[0].length;
  let shown = 0;
  for (const hunk of conflict.hunks) {
    const block = hunkBlock(hunk, sides);
    // Reserve room for the note about hunks that did not fit.
    if (used + block.length + 2 > CONTEXT_MAX - 60) break;
    parts.push(block);
    used += block.length + 2;
    shown += 1;
  }
  const dropped = conflict.hunks.length - shown;
  if (dropped > 0) parts.push(`[${dropped} more hunks not shown]`);
  return clip(parts.join('\n\n'), CONTEXT_MAX);
};

export const conflictToDecisionRequest = (
  conflict: WorkspaceMergeConflict,
  sides: { base: string; branch: string },
): WorkspaceConflictRequest => {
  const [first] = conflict.hunks;
  const line = first ? `:${first.line}` : '';
  const location = clip(conflict.path, TITLE_MAX - TITLE_PREFIX.length - line.length) + line;
  const base = clip(sides.base, LABEL_MAX - 'Keep '.length);
  const branch = clip(sides.branch, LABEL_MAX - 'Keep '.length);
  return {
    title: `${TITLE_PREFIX}${location}`,
    question: clip(`${branch} and ${base} both changed ${location}. Which version should land?`, QUESTION_MAX),
    context: contextFor(conflict, sides),
    decisionClass: 'implementation',
    options: [
      {
        label: `Keep ${base}`,
        // A binary or modify/delete conflict has no lines to show, so the option
        // carries no description. An empty string is refused at the door.
        ...(first ? { description: clip(sideText(first.ours), DESCRIPTION_MAX) } : {}),
      },
      {
        label: `Keep ${branch}`,
        ...(first ? { description: clip(sideText(first.theirs), DESCRIPTION_MAX) } : {}),
      },
      { label: 'Write the merged text', description: 'Reply with the text to land, and the merge runs again.' },
    ],
  };
};
