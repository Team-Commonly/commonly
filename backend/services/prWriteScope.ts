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
/** The most file text one owner card carries, across every file. */
export const CARD_CONTENTS_MAX = 64 * 1024;
const CARD_MESSAGE_MAX = 4096;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const shortSha = (sha: string): string => sha.slice(0, 7);

/** The commit message as the owner reads it: whole, labelled, and cut only past the cap. */
const cardMessage = (message: string): Record<string, unknown> => {
  const truncated = message.length > CARD_MESSAGE_MAX;
  return {
    label: 'Full commit message, exactly as it will be recorded',
    text: truncated
      ? `${message.slice(0, CARD_MESSAGE_MAX)}\n`
        + `[truncated: the card shows ${CARD_MESSAGE_MAX} of ${message.length} characters]`
      : message,
    length: message.length,
    truncated,
  };
};

/**
 * Each file's text, up to CARD_CONTENTS_MAX bytes across the whole commit. A
 * file cut short ends in a marker; a file past the cap shows no text at all and
 * says so. The envelope that runs is never cut.
 */
const cardFiles = (files: Array<{ path?: unknown; content?: unknown }>): {
  files: Array<Record<string, unknown>>;
  contents: Record<string, unknown>;
} => {
  let remaining = CARD_CONTENTS_MAX;
  let totalBytes = 0;
  let shownBytes = 0;
  const shown = files.map((file) => {
    const content = Buffer.from(str(file.content), 'utf8');
    totalBytes += content.length;
    const take = Math.min(content.length, remaining);
    remaining -= take;
    shownBytes += take;
    const truncated = take < content.length;
    const text = content.subarray(0, take).toString('utf8');
    return {
      path: str(file.path),
      bytes: content.length,
      content: truncated && take > 0
        ? `${text}\n[truncated: the card shows ${take} of ${content.length} bytes]`
        : text,
      truncated,
    };
  });
  return {
    files: shown,
    contents: {
      label: 'File contents, exactly as they will be committed (shown to the connection owner only)',
      shownBytes,
      totalBytes,
      truncated: shownBytes < totalBytes,
    },
  };
};

/**
 * What the owner's card shows for a parked PR write, in place of its envelope.
 * A push shows ids and size, never its bundle. A commit shows its full message
 * and its file text up to CARD_CONTENTS_MAX: this summary is built ONLY for the
 * connection owner's own pending read (`buildOwnerCardPayload`), never for the
 * pod card, a socket emit or another member's read. `null` for any other tool,
 * whose card keeps its arguments.
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
    const head = str(a.branch);
    const parentSha = str(a.parentSha);
    const branchExists = a.branchExists === true;
    const message = str(a.message);
    return {
      repo,
      // An existing branch continues from its own tip; its base names nothing that happens.
      ...(branchExists ? {} : { base: str(a.base) }),
      head,
      lands: branchExists
        ? `adds to existing branch ${head} at ${shortSha(parentSha)}`
        : `new branch ${head} from ${str(a.base)} at ${shortSha(parentSha)}`,
      subject: message.split('\n', 1)[0],
      message: cardMessage(message),
      ...cardFiles(files),
      fileCount: files.length, parentSha, branchExists,
    };
  }
  // github.push_branch. Commit subjects would mean unpacking the bundle to
  // draw a card; the ids and size say what lands.
  return {
    repo, head: str(a.ref).replace(/^refs\/heads\//, ''), baseOid: str(a.baseOid), newOid: str(a.newOid),
    bundleBytes: Buffer.from(str(a.bundle), 'base64').length,
  };
};
