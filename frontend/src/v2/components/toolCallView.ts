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
}

export interface ToolCallView {
  verb: { key: string; vars: Record<string, string> } | null;
  rows: ToolCallRow[];
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
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

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

  if (owner !== undefined || repo !== undefined) {
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
    if (!(key in args)) return;
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

  if ('headSha' in args) {
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
    const labelKey = LABEL_KEYS[key];
    const isLabels = key === 'labels' && Array.isArray(raw) && raw.every((label) => typeof label === 'string');
    rows.push({
      keys: [key],
      ...(labelKey ? { labelKey } : {}),
      label: key,
      value: isLabels ? (raw as string[]).join(', ') : asText(raw),
      kind: BLOCK_KEYS.has(key) && typeof raw === 'string'
        ? 'block'
        : (typeof raw === 'string' || isLabels ? 'text' : 'mono'),
    });
  }

  const verbKey = VERB_KEYS[tool];
  const number = isPositiveInteger(args.pullNumber) ? args.pullNumber
    : (isPositiveInteger(args.issueNumber) ? args.issueNumber : null);
  // A numbered verb with no valid number would read "#undefined"; fall back to the tool name.
  const needsNumber = verbKey && verbKey !== VERB_KEYS['github.create_issue'];
  const verb = verbKey && (!needsNumber || number !== null)
    ? { key: verbKey, vars: number !== null ? { number: String(number) } : {} }
    : null;
  return { verb, rows };
};
