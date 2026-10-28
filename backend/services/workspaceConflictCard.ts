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

// The fields Stack's walk recorded for a `Conflict`: the path, the kind, the
// line, and both sides' lines under `hunks`. Confirm these against the LayerFS
// type before the driver lands.
export interface WorkspaceMergeConflict {
  path: string;
  kind: string;
  line?: number;
  hunks: Array<{ ours: string; theirs: string }>;
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

export const conflictToDecisionRequest = (
  conflict: WorkspaceMergeConflict,
  sides: { base: string; branch: string },
): WorkspaceConflictRequest => {
  const location = conflict.line ? `${conflict.path}:${conflict.line}` : conflict.path;
  const hunks = conflict.hunks.map((hunk) => (
    `${sides.base}: ${clip(hunk.ours, SIDE_CLIP)}\n${sides.branch}: ${clip(hunk.theirs, SIDE_CLIP)}`
  ));
  const [first] = conflict.hunks;
  const ours = clip(first?.ours ?? '', SIDE_CLIP);
  const theirs = clip(first?.theirs ?? '', SIDE_CLIP);
  return {
    title: `Merge conflict in ${location}`,
    question: `${sides.branch} and ${sides.base} both changed ${location}. Which version should land?`,
    context: [`Conflict kind: ${conflict.kind}`, ...hunks].join('\n\n'),
    decisionClass: 'implementation',
    options: [
      { label: `Keep ${sides.base}`, description: ours },
      { label: `Keep ${sides.branch}`, description: theirs },
      { label: 'Write the merged text', description: 'Reply with the text to land, and the merge runs again.' },
    ],
  };
};
