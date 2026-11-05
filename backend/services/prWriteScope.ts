/**
 * `prWrite` (TASK-783, F163): the one GitHub write a hosted agent or a named
 * BYO seat may hold — opening a pull request from its own `seat/<agentUserId>/`
 * branch, and putting commits on that branch first.
 *
 * The scope is a grant field, off unless the granter sets it at mint, and it
 * never stands alone:
 *   - it needs a GitHub App connection and `write-with-confirm`;
 *   - the grant names `github.create_pull_request`;
 *   - the grant names no other write: the PR tools are the only writes on it;
 *   - each of its tools parks every call for the connection owner
 *     (`requiresApproval` on the definition), whatever the grant's mode.
 *
 * Every PR-write tool is refused on a grant whose lineage does not hold the
 * scope, for every caller. A grant that holds the scope, or names a BYO seat,
 * runs no other GitHub write at all (`toolBrokerService.prWriteRefusal`).
 */
import type { RoomGrantWriteMode } from '../models/RoomGrant';

export const PR_WRITE_TOOLS: ReadonlyArray<string> = [
  'github.create_pull_request',
  'github.commit_files',
  'github.push_branch',
];

export const isPrWriteTool = (tool: unknown): boolean => PR_WRITE_TOOLS.includes(String(tool));

/** Exactly `true`; a missing or truthy-but-not-boolean value holds nothing. */
export const grantHoldsPrWrite = (grant: unknown): boolean => (
  Boolean(grant) && (grant as { prWrite?: unknown }).prWrite === true
);

export type PrWriteMintRefusal = 'pr_write_github_only' | 'pr_write_requires_confirm'
  | 'pr_write_requires_create_pull_request' | 'pr_write_other_writes';

export const prWriteMintRefusalMessage = (reason: PrWriteMintRefusal): string => ({
  pr_write_github_only: 'Pull-request access is offered only on a GitHub App connection.',
  pr_write_requires_confirm: 'Pull-request access asks you each time; grant it as write-with-confirm.',
  pr_write_requires_create_pull_request: 'Pull-request access needs github.create_pull_request in the grant.',
  pr_write_other_writes: 'A grant with pull-request access can hold no other GitHub write.',
}[reason]);

/**
 * Checked at mint for a grant that asks for `prWrite`. `requiredWriteModeOf`
 * is the broker's own definition map, so the server decides what is a write.
 */
export const prWriteMintRefusal = (input: {
  connectionType: unknown;
  writeMode: unknown;
  tools: string[];
  requiredWriteModeOf: (tool: string) => RoomGrantWriteMode | undefined;
}): PrWriteMintRefusal | null => {
  if (input.connectionType !== 'github-app') return 'pr_write_github_only';
  if (input.writeMode !== 'write-with-confirm') return 'pr_write_requires_confirm';
  if (!input.tools.includes('github.create_pull_request')) return 'pr_write_requires_create_pull_request';
  const otherWrite = input.tools.some((tool) => !isPrWriteTool(tool)
    && (input.requiredWriteModeOf(tool) ?? 'write') !== 'read');
  return otherWrite ? 'pr_write_other_writes' : null;
};

const BODY_PREVIEW = 2000;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * What the owner's card shows for a parked PR write, in place of its envelope:
 * enough to decide on, and never a push's bundle or a commit's file contents.
 * `null` for any other tool, whose card keeps its arguments.
 */
export const prWriteApprovalSummary = (tool: unknown, args: unknown): Record<string, unknown> | null => {
  if (!isPrWriteTool(tool) || !args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const repo = `${str(a.owner)}/${str(a.repo)}`;
  if (tool === 'github.create_pull_request') {
    const body = str(a.body);
    return {
      repo, base: str(a.base), head: str(a.head), title: str(a.title), draft: a.draft === true,
      bodyPreview: body.slice(0, BODY_PREVIEW), bodyLength: body.length,
    };
  }
  if (tool === 'github.commit_files') {
    const files = Array.isArray(a.files) ? a.files as Array<{ path?: unknown; content?: unknown }> : [];
    return {
      repo, base: str(a.base), head: str(a.branch), subject: str(a.message).split('\n', 1)[0],
      files: files.map((file) => ({ path: str(file.path), bytes: Buffer.byteLength(str(file.content), 'utf8') })),
      fileCount: files.length, parentSha: str(a.parentSha), branchExists: a.branchExists === true,
    };
  }
  // github.push_branch. Commit subjects would mean unpacking the bundle to
  // draw a card; the ids and size say what lands.
  return {
    repo, head: str(a.ref).replace(/^refs\/heads\//, ''), baseOid: str(a.baseOid), newOid: str(a.newOid),
    bundleBytes: Buffer.from(str(a.bundle), 'base64').length,
  };
};
