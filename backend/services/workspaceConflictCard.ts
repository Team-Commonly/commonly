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
 * One merge gives one request, however many paths conflict, and the request
 * carries the heads it was built from (`merge`), so the re-run can refuse if
 * either side moved after the person decided. Sides are ours and theirs, by
 * branch name; "base" means only the merge base.
 *
 * Every field is clipped to the limits decisionRequestService enforces, so a
 * request this module builds is accepted at the door.
 */
import type { DecisionClass } from './decisionRequestService';

// The Conflict shape LayerFS 582bc786f9 returns. A refused merge carries
// `detail.conflicts[]`, one entry per file. A content conflict has `hunks`, with
// the line and both sides as arrays of lines. A text modify/delete or
// delete/modify carries one hunk with the kept side's lines. A binary conflict,
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

// A refused merge's `detail`. `sources` is [ours, theirs], the merge's first and
// second arguments, each a branch name (`ref`) and the head it merged
// (`node`). `mergeBase` is the common ancestor. `conflictsTruncated` says the
// merge listed only some conflicting paths.
export interface WorkspaceMergeSource {
  ref: string;
  node: string;
}

export interface WorkspaceMergeRefusal {
  sources: WorkspaceMergeSource[];
  mergeBase: string;
  conflicts: WorkspaceMergeConflict[];
  conflictsTruncated?: boolean;
}

// The heads the person decided on. The re-run passes them back to the merge
// (as `expect`), so it refuses if either side moved after the card was shown.
export interface WorkspaceMergeBinding {
  ours: WorkspaceMergeSource;
  theirs: WorkspaceMergeSource;
  mergeBase: string;
}

export interface WorkspaceConflictRequest {
  title: string;
  question: string;
  context: string;
  decisionClass: DecisionClass;
  options: Array<{ label: string; description?: string }>;
  merge: WorkspaceMergeBinding;
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

// The drawn markers are themselves characters a file can hold, so a literal
// marker, or a literal backslash, is escaped first. Otherwise ' return' and
// '·return' would render the same.
const ESCAPES: Record<string, string> = { '\\': '\\\\', '·': '\\u00b7', '→': '\\u2192' };
const escapeMarkers = (line: string): string => line.replace(/[\\·→]/g, (ch) => ESCAPES[ch]);

// Leading and trailing whitespace is drawn, not trimmed: two sides that differ
// only in indentation must look different to the person deciding. Descriptions
// are trimmed by normalizeOptions, so the drawn dots survive it.
const drawSpaces = (run: string): string => run.replace(/ /g, '·').replace(/\t/g, '→');
const showWhitespace = (line: string): string => escapeMarkers(line)
  .replace(/^[ \t]+/, drawSpaces)
  .replace(/[ \t]+$/, drawSpaces);

const sideText = (lines: string[]): string => {
  if (!lines.join('').trim()) return '(empty)';
  return clip(lines.map(showWhitespace).join('\n'), SIDE_CLIP);
};

type Sides = { ours: string; theirs: string };

const hunkBlock = (hunk: WorkspaceMergeHunk, sides: Sides): string => (
  `line ${hunk.line}\n${sides.ours}: ${sideText(hunk.ours)}\n${sides.theirs}: ${sideText(hunk.theirs)}`
);

// Git's own files (/.git/index above all) differ on almost every merge where an
// agent ran git. They hold no source text a person can choose between, so
// beside real files they're one line of context, not choices of their own.
const isGitMetadata = (path: string): boolean => path === '/.git' || path.startsWith('/.git/');

// LayerFS names a kind by who did what: `modify/delete` means ours changed the
// file and theirs deleted it; `delete/modify` is the reverse. The side that
// deleted gets a description that says so, because picking it removes the file.
const deletedBy = (kind: string): 'ours' | 'theirs' | null => {
  if (kind === 'modify/delete') return 'theirs';
  if (kind === 'delete/modify') return 'ours';
  return null;
};

const shortNode = (node: string): string => (node.length > 12 ? node.slice(0, 12) : node) || '(unknown)';

const fileHeading = (conflict: WorkspaceMergeConflict): string => {
  const facts = [conflict.kind];
  if (conflict.blocks !== undefined) facts.push(`${conflict.blocks} conflict block${conflict.blocks === 1 ? '' : 's'}`);
  const notes: string[] = [];
  if (conflict.hunks.length === 0 && !conflict.hunksOmitted) {
    notes.push('No line-level hunks: the two sides differ as a whole.');
  }
  if (conflict.hunksOmitted) notes.push('Some hunks were omitted by the merge.');
  return [`File ${conflict.path} (${facts.join(', ')})`, ...notes].join('\n');
};

const contextFor = (
  files: WorkspaceMergeConflict[],
  gitLine: string,
  sides: Sides,
  merge: WorkspaceMergeBinding,
  truncated: boolean,
): string => {
  // The full names, so a clipped label never hides which branch is which.
  const header = [
    `Sides: ${clip(sides.ours, 100)} (ours) and ${clip(sides.theirs, 100)} (theirs).`,
    `Heads: ours ${shortNode(merge.ours.node)}, theirs ${shortNode(merge.theirs.node)}, `
      + `merge base ${shortNode(merge.mergeBase)}.`,
    `Conflicting files: ${files.length}${truncated ? ' listed; the merge listed only some.' : ''}`,
  ].join('\n');
  const parts = [header];
  // Room is kept for the git line and for the notes about what didn't fit.
  const budget = CONTEXT_MAX - 80 - (gitLine ? gitLine.length + 2 : 0);
  let used = header.length;
  let filesShown = 0;
  let hunksDropped = 0;
  for (const file of files) {
    const heading = fileHeading(file);
    if (used + heading.length + 2 > budget) break;
    parts.push(heading);
    used += heading.length + 2;
    filesShown += 1;
    let shown = 0;
    for (const hunk of file.hunks) {
      const block = hunkBlock(hunk, sides);
      if (used + block.length + 2 > budget) break;
      parts.push(block);
      used += block.length + 2;
      shown += 1;
    }
    hunksDropped += file.hunks.length - shown;
    if (shown < file.hunks.length) break;
  }
  if (gitLine) parts.push(gitLine);
  const notes: string[] = [];
  if (hunksDropped > 0) notes.push(`${hunksDropped} more hunks`);
  if (files.length > filesShown) notes.push(`${files.length - filesShown} more files`);
  if (notes.length) parts.push(`[${notes.join(' and ')} not shown]`);
  return clip(parts.join('\n\n'), CONTEXT_MAX);
};

const sourceOf = (
  sources: WorkspaceMergeSource[] | undefined, index: number, fallback: string,
): WorkspaceMergeSource => ({
  ref: String(sources?.[index]?.ref || fallback),
  node: String(sources?.[index]?.node || ''),
});

/**
 * One merge, one decision request, however many paths conflict. The options
 * apply to the whole merge: keep ours, keep theirs, or write the merged text.
 */
export const mergeConflictToDecisionRequest = (detail: WorkspaceMergeRefusal): WorkspaceConflictRequest => {
  const merge: WorkspaceMergeBinding = {
    ours: sourceOf(detail.sources, 0, 'ours'),
    theirs: sourceOf(detail.sources, 1, 'theirs'),
    mergeBase: String(detail.mergeBase || ''),
  };
  const sides: Sides = { ours: merge.ours.ref, theirs: merge.theirs.ref };
  const all = Array.isArray(detail.conflicts) ? detail.conflicts : [];
  const source = all.filter((c) => !isGitMetadata(c.path));
  const git = all.filter((c) => isGitMetadata(c.path));
  // Git's files alone are still a refused merge, so they become the choices then.
  const files = source.length ? source : git;
  const gitLine = source.length && git.length
    ? clip(`Git's own files also differ: ${git.map((c) => c.path).join(', ')}. `
      + 'They hold no source text, so they aren\'t listed as choices.', 300)
    : '';

  const ours = clip(sides.ours, LABEL_MAX - 'Keep ours ()'.length);
  const theirs = clip(sides.theirs, LABEL_MAX - 'Keep theirs ()'.length);
  const [only] = files.length === 1 ? files : [];
  const first = only?.hunks[0];
  const line = first ? `:${first.line}` : '';
  const head = files[0]?.path || '';
  const more = files.length > 1 ? ` and ${files.length - 1} more file${files.length === 2 ? '' : 's'}` : '';
  const location = head
    ? clip(head, TITLE_MAX - TITLE_PREFIX.length - line.length - more.length) + line
    : `${clip(theirs, 60)} into ${clip(ours, 60)}`;
  const deleter = only ? deletedBy(only.kind) : null;

  let question: string;
  if (deleter) {
    const [gone, kept] = deleter === 'ours' ? [ours, theirs] : [theirs, ours];
    question = `${gone} deleted ${location}, and ${kept} changed it. Which should land?`;
  } else if (files.length > 1) {
    const paths = files.map((c) => c.path).join(', ');
    question = `${theirs} and ${ours} both changed the same ${files.length} files: ${paths}. `
      + 'Which version should land?';
  } else {
    question = `${theirs} and ${ours} both changed ${location}. Which version should land?`;
  }

  // One file: each side's own lines. Several: what picking the side does, and
  // how many files that side deleted, so picking it is never a silent delete.
  // An empty string is refused at the door, so a side with nothing to show gets
  // no description at all (binary conflicts have no hunks).
  const describe = (side: 'ours' | 'theirs'): { description?: string } => {
    if (only) {
      if (deleter === side) {
        return { description: clip(`Delete ${only.path}: ${sides[side]} deleted it.`, DESCRIPTION_MAX) };
      }
      const lines = side === 'ours' ? first?.ours : first?.theirs;
      return first && lines ? { description: clip(sideText(lines), DESCRIPTION_MAX) } : {};
    }
    if (files.length < 2) return {};
    const deleted = files.filter((c) => deletedBy(c.kind) === side).length;
    const tail = deleted ? ` It deleted ${deleted} of them.` : '';
    return { description: clip(`Take ${sides[side]}'s version of all ${files.length} files.${tail}`, DESCRIPTION_MAX) };
  };

  return {
    title: `${TITLE_PREFIX}${location}${more}`,
    question: clip(question, QUESTION_MAX),
    context: contextFor(files, gitLine, sides, merge, Boolean(detail.conflictsTruncated)),
    decisionClass: 'implementation',
    options: [
      { label: `Keep ours (${ours})`, ...describe('ours') },
      { label: `Keep theirs (${theirs})`, ...describe('theirs') },
      { label: 'Write the merged text', description: 'Reply with the text to land, and the merge runs again.' },
    ],
    merge,
  };
};
