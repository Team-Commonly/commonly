// A parked connector call, readable: the verb on the action line and every
// pinned argument as a labelled row (demo plan must-have 6, Sam's "small
// sub-UI for external connectors").
//
// The card is a consent surface, so this view may relabel and format, but it
// never drops an argument: every key of `canonicalArgs` lands in a row (owner
// and repo share one), and the exact JSON stays one click away beside it.
// Rows are built from the server-pinned arguments only, never from the
// agent's prose.

export type ToolCallRowKind = 'text' | 'mono' | 'block';

export interface ToolCallRow {
  /** The canonical argument key(s) this row shows. */
  keys: string[];
  /** i18n key for the row label; absent for an argument with no known name. */
  labelKey?: string;
  /** The raw argument name, shown when there is no labelKey. */
  label: string;
  value: string;
  kind: ToolCallRowKind;
  /** A github.com link, built only from validated pinned values. */
  href?: string;
  /** The full value when `value` is shortened (a commit SHA). */
  title?: string;
  /** i18n key that stands in for `value` (a yes or no). */
  valueKey?: string;
  /** Text shown whole beneath `value`, as code (a file's contents). */
  detail?: string;
  /** A line about the row itself. */
  note?: { key: string; vars: Record<string, string> };
  /** Set when a block is longer than its scrolling box shows at once. */
  fullLength?: number;
}

export interface ToolCallView {
  verb: { key: string; vars: Record<string, string> } | null;
  rows: ToolCallRow[];
  /** What the owner should know that no row shows. */
  notices?: Array<{ key: string; vars: Record<string, string> }>;
}

const VERB_KEYS: Record<string, string> = {
  'github.merge_pull_request': 'approvalCard.toolCall.verb.mergePullRequest',
  'github.create_issue': 'approvalCard.toolCall.verb.createIssue',
  'github.comment_on_issue': 'approvalCard.toolCall.verb.commentOnIssue',
  'github.close_issue': 'approvalCard.toolCall.verb.closeIssue',
};

const LABEL_KEYS: Record<string, string> = {
  mergeMethod: 'approvalCard.toolCall.label.mergeMethod',
  commitTitle: 'approvalCard.toolCall.label.commitTitle',
  commitMessage: 'approvalCard.toolCall.label.commitMessage',
  title: 'approvalCard.toolCall.label.title',
  body: 'approvalCard.toolCall.label.body',
  labels: 'approvalCard.toolCall.label.labels',
};

const BLOCK_KEYS = new Set(['body', 'commitMessage']);

// A GitHub owner or repository name, as GitHub allows them. Anything else is
// shown as text and never put in a URL.
const GITHUB_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

// Past either of these, a block scrolls inside its 12em box and has to say so.
const LONG_VALUE_CHARS = 400;
const LONG_VALUE_LINES = 8;
const isLong = (text: string): boolean => (
  text.length > LONG_VALUE_CHARS || text.split('\n').length > LONG_VALUE_LINES
);

// Text an outsider may have written reaches this card through the model. A
// bidi override, zero-width or tag character draws one thing and runs another,
// so each is shown as its code point. Tab and the line breaks stay real.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]|(?![\t\n\r])\p{Cc}/gu;
export const showInvisibles = (text: string): string => text.replace(
  INVISIBLE,
  (char) => `\\u{${(char.codePointAt(0) as number).toString(16).toUpperCase()}}`,
);

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value ?? null);
};

const isPositiveInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value > 0
);

export const toolCallView = (tool: string, args: Record<string, unknown>): ToolCallView => {
  const rows: ToolCallRow[] = [];
  const shown = new Set<string>();
  const isGithub = tool.startsWith('github.');
  const { owner, repo } = args;
  const repoBase = isGithub && typeof owner === 'string' && typeof repo === 'string'
    && GITHUB_SEGMENT.test(owner) && GITHUB_SEGMENT.test(repo)
    ? `https://github.com/${owner}/${repo}`
    : undefined;

  // GitHub-shaped rows (repository, PR, issue, head) are GitHub's vocabulary.
  // On any other tool `owner` may be a person, so those keys stay plain rows
  // under their own names.
  if (isGithub && (owner !== undefined || repo !== undefined)) {
    const keys = ['owner', 'repo'].filter((key) => key in args);
    rows.push({
      keys,
      labelKey: 'approvalCard.toolCall.label.repository',
      label: keys.join('/'),
      value: [owner, repo].filter((part) => part !== undefined).map(asText).join('/'),
      kind: 'text',
      ...(repoBase ? { href: repoBase } : {}),
    });
    keys.forEach((key) => shown.add(key));
  }

  const numbered = (key: 'pullNumber' | 'issueNumber', path: 'pull' | 'issues', labelKey: string) => {
    if (!isGithub || !(key in args)) return;
    const raw = args[key];
    rows.push({
      keys: [key],
      labelKey,
      label: key,
      value: isPositiveInteger(raw) ? `#${raw}` : asText(raw),
      kind: 'text',
      ...(repoBase && isPositiveInteger(raw) ? { href: `${repoBase}/${path}/${raw}` } : {}),
    });
    shown.add(key);
  };
  numbered('pullNumber', 'pull', 'approvalCard.toolCall.label.pullRequest');
  numbered('issueNumber', 'issues', 'approvalCard.toolCall.label.issue');

  if (isGithub && 'headSha' in args) {
    const raw = args.headSha;
    const sha = typeof raw === 'string' && COMMIT_SHA.test(raw) ? raw : null;
    rows.push({
      keys: ['headSha'],
      labelKey: 'approvalCard.toolCall.label.head',
      label: 'headSha',
      value: sha ? sha.slice(0, 7) : asText(raw),
      kind: 'mono',
      ...(sha ? { title: sha } : {}),
      ...(sha && repoBase ? { href: `${repoBase}/commit/${sha}` } : {}),
    });
    shown.add('headSha');
  }

  for (const [key, raw] of Object.entries(args)) {
    if (shown.has(key)) continue;
    const labelKey = Object.prototype.hasOwnProperty.call(LABEL_KEYS, key) ? LABEL_KEYS[key] : undefined;
    const isLabels = key === 'labels' && Array.isArray(raw) && raw.every((label) => typeof label === 'string');
    rows.push({
      keys: [key],
      ...(labelKey ? { labelKey } : {}),
      label: key,
      value: isLabels ? JSON.stringify(raw) : asText(raw),
      // A multi-line string keeps its line breaks, whatever its key.
      kind: typeof raw === 'string' && (BLOCK_KEYS.has(key) || raw.includes('\n') || isLong(raw))
        ? 'block'
        : (typeof raw === 'string' || isLabels ? 'text' : 'mono'),
      ...(typeof raw === 'string' && isLong(raw) ? { fullLength: raw.length } : {}),
    });
  }

  const verbKey = Object.prototype.hasOwnProperty.call(VERB_KEYS, tool) ? VERB_KEYS[tool] : undefined;
  const requiredNumber = tool === 'github.merge_pull_request' ? args.pullNumber
    : (tool === 'github.comment_on_issue' || tool === 'github.close_issue' ? args.issueNumber : null);
  const number = isPositiveInteger(requiredNumber) ? requiredNumber : null;
  // A numbered verb with no valid number would read "#undefined"; fall back to the tool name.
  const needsNumber = verbKey && verbKey !== VERB_KEYS['github.create_issue'];
  const verb = verbKey && (!needsNumber || number !== null)
    ? { key: verbKey, vars: number !== null ? { number: String(number) } : {} }
    : null;
  return { verb, rows: rows.map((row) => ({ ...row, value: showInvisibles(row.value) })) };
};

const PR_WRITE_VERBS: Record<string, string> = {
  'github.create_pull_request': 'approvalCard.toolCall.verb.createPullRequest',
  'github.commit_files': 'approvalCard.toolCall.verb.commitFiles',
  'github.push_branch': 'approvalCard.toolCall.verb.pushBranch',
};

const SUMMARY_LABEL_KEYS: Record<string, string> = {
  repo: 'approvalCard.toolCall.label.repository',
  base: 'approvalCard.toolCall.label.base',
  head: 'approvalCard.toolCall.label.branch',
  lands: 'approvalCard.toolCall.label.lands',
  title: 'approvalCard.toolCall.label.title',
  subject: 'approvalCard.toolCall.label.commitTitle',
  message: 'approvalCard.toolCall.label.commitMessage',
  bodyPreview: 'approvalCard.toolCall.label.body',
  bodyLength: 'approvalCard.toolCall.label.bodyLength',
  draft: 'approvalCard.toolCall.label.draft',
  fileCount: 'approvalCard.toolCall.label.fileCount',
  branchExists: 'approvalCard.toolCall.label.branchExists',
  parentSha: 'approvalCard.toolCall.label.parentCommit',
  baseOid: 'approvalCard.toolCall.label.baseCommit',
  newOid: 'approvalCard.toolCall.label.newCommit',
  bundleBytes: 'approvalCard.toolCall.label.bundleSize',
};
const SUMMARY_COMMIT_KEYS = new Set(['parentSha', 'baseOid', 'newOid']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

/** Whether the owner can be shown this parked call at all. Approve depends on it. */
export const canShowToolCall = (envelope?: {
  tool?: string;
  canonicalArgs?: unknown;
  summary?: unknown;
}): boolean => {
  if (!envelope?.tool) return false;
  if (isRecord(envelope.canonicalArgs)) return true;
  return Object.prototype.hasOwnProperty.call(PR_WRITE_VERBS, envelope.tool)
    && isRecord(envelope.summary)
    && Object.keys(envelope.summary).length > 0;
};

// A path is the agent's to choose, so it is never a row's label: a file called
// "Repository" must not read like the repository row.
const fileRow = (file: Record<string, unknown>, index: number): ToolCallRow => {
  const content = asText(file.content);
  const bytes = asText(file.bytes);
  const notShown = file.truncated === true && content === '';
  return {
    keys: ['files', String(index)],
    labelKey: 'approvalCard.toolCall.label.file',
    label: 'file',
    value: asText(file.path),
    kind: 'mono',
    ...(notShown ? {} : { detail: content }),
    note: {
      key: `approvalCard.toolCall.file.${notShown ? 'notShown' : (file.truncated === true ? 'cut' : 'size')}`,
      vars: { bytes },
    },
  };
};

/**
 * A parked PR write, readable. The server keeps a commit's or push's raw
 * arguments on the row and sends the owner `summary` in their place
 * (buildOwnerCardPayload), so this is the only view of the call the owner gets.
 * Like toolCallView it may format but never drops, and because Approve runs the
 * whole call, whatever the summary leaves out is said in `notices`.
 */
export const prWriteView = (tool: string, summary: Record<string, unknown>): ToolCallView => {
  const rows: ToolCallRow[] = [];
  const notices: ToolCallView['notices'] = [];
  for (const [key, raw] of Object.entries(summary)) {
    const labelKey = Object.prototype.hasOwnProperty.call(SUMMARY_LABEL_KEYS, key)
      ? SUMMARY_LABEL_KEYS[key]
      : undefined;
    if (key === 'files' && Array.isArray(raw)) {
      raw.filter(isRecord).forEach((file, index) => rows.push(fileRow(file, index)));
    } else if (key === 'contents' && isRecord(raw)) {
      if (raw.truncated === true) {
        notices.push({
          key: 'approvalCard.toolCall.notice.contentsCut',
          vars: { shown: asText(raw.shownBytes), total: asText(raw.totalBytes) },
        });
      }
    } else if (key === 'message' && isRecord(raw)) {
      rows.push({ keys: [key], labelKey, label: key, value: asText(raw.text), kind: 'block' });
      if (raw.truncated === true) {
        notices.push({ key: 'approvalCard.toolCall.notice.messageCut', vars: { total: asText(raw.length) } });
      }
    } else if (key === 'bodyPreview') {
      rows.push({ keys: [key], labelKey, label: key, value: asText(raw), kind: 'block' });
      const shown = asText(raw).length;
      if (typeof summary.bodyLength === 'number' && summary.bodyLength > shown) {
        notices.push({
          key: 'approvalCard.toolCall.notice.bodyCut',
          vars: { shown: String(shown), total: String(summary.bodyLength) },
        });
      }
    } else if (typeof raw === 'boolean') {
      rows.push({
        keys: [key],
        labelKey,
        label: key,
        value: asText(raw),
        valueKey: `approvalCard.toolCall.${raw ? 'yes' : 'no'}`,
        kind: 'text',
      });
    } else {
      const [owner, name, extra] = key === 'repo' && typeof raw === 'string' ? raw.split('/') : [];
      const sha = SUMMARY_COMMIT_KEYS.has(key) && typeof raw === 'string' && COMMIT_SHA.test(raw) ? raw : null;
      rows.push({
        keys: [key],
        ...(labelKey ? { labelKey } : {}),
        label: key,
        value: sha ? sha.slice(0, 7) : `${asText(raw)}${key === 'bundleBytes' ? ' B' : ''}`,
        kind: sha ? 'mono' : 'text',
        ...(sha ? { title: sha } : {}),
        ...(owner && name && extra === undefined && GITHUB_SEGMENT.test(owner) && GITHUB_SEGMENT.test(name)
          ? { href: `https://github.com/${owner}/${name}` }
          : {}),
      });
    }
  }
  if (tool === 'github.push_branch') notices.push({ key: 'approvalCard.toolCall.notice.pushContents', vars: {} });
  const verbKey = PR_WRITE_VERBS[tool];
  const namesBranch = tool !== 'github.create_pull_request';
  return {
    verb: verbKey && (!namesBranch || typeof summary.head === 'string')
      ? { key: verbKey, vars: namesBranch ? { head: summary.head as string } : {} }
      : null,
    rows: rows.map((row) => ({
      ...row,
      value: showInvisibles(row.value),
      ...(row.detail === undefined ? {} : { detail: showInvisibles(row.detail) }),
    })),
    notices,
  };
};
