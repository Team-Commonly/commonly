/**
 * TASK-597 (D155, ADR-008): a workspace merge that conflicts becomes a decision
 * request, not a failed turn.
 *
 * A LayerFS `branch.merge` refuses atomically on a conflict: nothing is created
 * and main is unchanged (Stack's L14 §10). That refusal is the card payload. The
 * agent raises it, a person picks a side or writes the merged text, and the
 * merge runs again. This module only shapes the request; the driver that calls
 * branch.merge is not wired yet.
 */
import type { DecisionClass } from './decisionRequestService';

// The shape measured on walk-1028 (LayerFS 582bc786f9, 2026-10-28): a refused
// merge carries `detail.conflicts[]`, one entry per file. A content conflict has
// `hunks` with the line and both sides as arrays of lines. A binary conflict,
// such as /.git/index, has no hunks.
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
  options: Array<{ label: string; description: string }>;
}

const SIDE_CLIP = 200;

const clip = (text: string, limit: number): string => (
  text.length > limit ? `${text.slice(0, limit)}…` : text
);

const sideText = (lines: string[]): string => clip(lines.join('\n'), SIDE_CLIP);

export const conflictToDecisionRequest = (
  conflict: WorkspaceMergeConflict,
  sides: { base: string; branch: string },
): WorkspaceConflictRequest => {
  const [first] = conflict.hunks;
  const location = first ? `${conflict.path}:${first.line}` : conflict.path;
  const hunks = conflict.hunks.map((hunk) => (
    `line ${hunk.line}\n${sides.base}: ${sideText(hunk.ours)}\n${sides.branch}: ${sideText(hunk.theirs)}`
  ));
  return {
    title: `Merge conflict in ${location}`,
    question: `${sides.branch} and ${sides.base} both changed ${location}. Which version should land?`,
    context: [`Conflict kind: ${conflict.kind}`, ...hunks].join('\n\n'),
    decisionClass: 'implementation',
    options: [
      { label: `Keep ${sides.base}`, description: first ? sideText(first.ours) : '' },
      { label: `Keep ${sides.branch}`, description: first ? sideText(first.theirs) : '' },
      { label: 'Write the merged text', description: 'Reply with the text to land, and the merge runs again.' },
    ],
  };
};
