/**
 * `github.commit_files` (TASK-783): put one commit of text files on the
 * caller's own `seat/<agentUserId>/` branch through the GitHub App, with no git
 * and no token in the caller's hands. It is how a hosted turn gets a head for
 * `github.create_pull_request`.
 *
 * The call always parks for the connection owner. At park time the server reads
 * the commit the new one will sit on (`parentSha`) and whether the branch exists,
 * and both ride in the approved envelope beside the agent's arguments. At
 * execution the branch must still be exactly there, so what the owner approved
 * is what lands: a moved or newly created branch refuses `stale_branch`.
 *
 * The base branch is read for a starting point and never written. Only the seat
 * branch moves, and only forward.
 *
 * A new branch starts at the repo's default branch and nowhere else
 * (`base_not_default`). Before any object is written, the parent's protected
 * files (`.github/workflows`, `.github/actions`, every CODEOWNERS) must equal
 * the default tip's (`protected_path_behind_default`), the same rule the bundle
 * push applies: a seat branch must not run, or ask review from, automation
 * policy the default branch has since replaced.
 */
import { sendWrite } from './brokerWriteOutcome';
import { RoomGrantError } from './roomGrantService';
import { PROTECTED_PATH } from './seatGithubPush';

// Typed, so tsc refuses a call that names an installation without its App (F172).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const GitHubAppService: typeof import('./githubAppService').default = require('./githubAppService');
import type { GitHubAppName } from './githubAppNames';

export const COMMIT_FILES_MAX_FILES = 50;
export const COMMIT_FILES_MAX_BYTES = 512 * 1024;
const MESSAGE_MAX = 4096;
const OID = /^[0-9a-f]{40}$/;
const AGENT_FIELDS = ['branch', 'base', 'message', 'files'];
/** Set by the server at park time; an agent that sends one is refused. */
const SERVER_FIELDS = ['parentSha', 'branchExists'];

/** The only branches a seat may write: its own, `seat/<agentUserId>/...`. */
export const assertOwnedSeatBranch = (head: unknown, agentUserId: string): void => {
  const prefix = `seat/${agentUserId}/`;
  if (typeof head !== 'string' || !agentUserId || !head.startsWith(prefix)
    || head.length > 200 || head.split('/').some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
      || part.includes('..') || part.endsWith('.lock') || part.endsWith('.'))) {
    throw new RoomGrantError('branch_not_owned_by_seat', 'PR head must belong to the authenticated seat', 403);
  }
};

const invalid = (message: string): RoomGrantError => new RoomGrantError('invalid_tool_args', message, 400);

/**
 * Characters that change how a path READS without changing what it is: bidi
 * controls (U+202A-202E, U+2066-2069), zero-width characters (U+200B-200D,
 * U+FEFF), every other format character (Cf), and the line and paragraph
 * separators. The owner approves a path by reading it on a card.
 */
const DECEPTIVE_PATH_CHARACTER = /[\p{Cf}\p{Zl}\p{Zp}\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/u;

/**
 * A trailer line that attributes the commit to someone: `Co-authored-by:`,
 * `Signed-off-by:`, `Reviewed-by:` and every other `<Word>-by:`, in any case.
 * A seat's commit is attributed to the App; it does not get to name people.
 */
const ATTRIBUTION_TRAILER = /^[ \t]*[A-Za-z][A-Za-z-]*-by[ \t]*:/im;

const validBranchName = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
  && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
  && !value.endsWith('.lock') && !value.endsWith('.');

/**
 * A repository-relative path of plain segments. No `.`/`..`, no `.git`
 * segment in any case, no backslash or control character, nothing absolute.
 */
const validPath = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 1024
  // eslint-disable-next-line no-control-regex
  && !/[\u0000-\u001f\u007f\\]/.test(value)
  && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'
    && part.toLowerCase() !== '.git');

export interface CommitFilesArgs {
  branch: string;
  base: string;
  message: string;
  files: Array<{ path: string; content: string }>;
}

/** Validate what an agent sends. Server-owned fields are refused here, not stripped. */
export const parseCommitFilesArgs = (
  raw: Record<string, unknown>,
  agentUserId: string,
  options: { allowServerFields?: boolean } = {},
): CommitFilesArgs => {
  const allowed = options.allowServerFields ? [...AGENT_FIELDS, ...SERVER_FIELDS] : AGENT_FIELDS;
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`unknown tool argument: ${unknown}`);
  assertOwnedSeatBranch(raw.branch, agentUserId);
  if (!validBranchName(raw.base)) throw invalid('base is not a valid branch name');
  if (typeof raw.message !== 'string' || !raw.message.trim() || raw.message.length > MESSAGE_MAX) {
    throw invalid(`message must be a non-empty string of at most ${MESSAGE_MAX} characters`);
  }
  if (ATTRIBUTION_TRAILER.test(raw.message)) {
    throw new RoomGrantError(
      'commit_attribution_trailer',
      'a commit message may not carry a trailer that attributes anyone (Co-authored-by:, Signed-off-by:, ...)',
      400,
    );
  }
  if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > COMMIT_FILES_MAX_FILES) {
    throw invalid(`files must hold 1 to ${COMMIT_FILES_MAX_FILES} entries`);
  }
  const seen = new Set<string>();
  let bytes = 0;
  const files = raw.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).some((key) => key !== 'path' && key !== 'content')) {
      throw invalid('each file is { path, content }');
    }
    const { path, content } = file as { path?: unknown; content?: unknown };
    if (typeof path === 'string' && DECEPTIVE_PATH_CHARACTER.test(path)) {
      throw new RoomGrantError('invalid_path', 'a file path holds an invisible or direction-changing character', 400);
    }
    if (!validPath(path)) throw invalid('a file path is not a plain repository path');
    if (typeof content !== 'string') throw invalid('file content must be text');
    if (content.includes('\u0000')) {
      throw new RoomGrantError('invalid_content', 'file content must be text: it holds a NUL byte', 400);
    }
    // Case-folded, so two spellings of one path on a case-insensitive checkout
    // cannot both ride in one commit.
    if (seen.has(path.toLowerCase())) throw invalid('a file path appears twice');
    seen.add(path.toLowerCase());
    // The same predicate the bundle push applies: automation policy is not a
    // seat's to change, by either route.
    if (PROTECTED_PATH(path)) {
      throw new RoomGrantError('push_protected_path', 'this path is not writable by a seat', 403);
    }
    bytes += Buffer.byteLength(content, 'utf8');
    return { path, content };
  });
  if (bytes > COMMIT_FILES_MAX_BYTES) throw invalid(`files exceed ${COMMIT_FILES_MAX_BYTES / 1024} KiB in total`);
  return { branch: raw.branch as string, base: raw.base, message: raw.message, files };
};

interface Connection { owner: string; repo: string; installationId: string; app: GitHubAppName; repositoryId?: string }

const gitData = (connection: Connection) => ({
  owner: connection.owner,
  repo: connection.repo,
  installationId: connection.installationId,
  app: connection.app,
  repositoryId: connection.repositoryId,
  forceApp: true,
});

const baseNotDefault = (): RoomGrantError => new RoomGrantError(
  'base_not_default', 'a new seat branch must start from the repository\'s default branch', 403,
);

/** Read the default branch now; a new branch starts there and nowhere else. */
const defaultBranchOf = async (connection: Connection): Promise<string> => {
  const name = await GitHubAppService.getDefaultBranch(gitData(connection));
  if (typeof name !== 'string' || !name) {
    throw new RoomGrantError('base_not_found', 'the connected repository reports no default branch', 404);
  }
  return name;
};

const assertBaseIsDefault = async (base: string, connection: Connection): Promise<void> => {
  if (base !== await defaultBranchOf(connection)) throw baseNotDefault();
};

type TreeEntry = { path: string; type: string; mode: string; sha: string };

/**
 * The protected entries of a tree, keyed by path: every blob and subtree
 * `PROTECTED_PATH` names, except the bare `.github` directory, whose id also
 * covers files nothing protects (issue templates and the like).
 */
const protectedEntriesOf = async (connection: Connection, treeSha: string): Promise<Map<string, string>> => {
  const listing = await GitHubAppService.getTreeEntries({ ...gitData(connection), sha: treeSha });
  if (!listing || listing.truncated === true || !Array.isArray(listing.entries)) {
    throw new RoomGrantError(
      'protected_path_unverifiable',
      'the repository tree is too large to compare its protected files; push through a reviewed branch instead',
      409,
    );
  }
  const entries = new Map<string, string>();
  for (const entry of listing.entries as TreeEntry[]) {
    if (!PROTECTED_PATH(entry.path)) continue;
    if (entry.type === 'tree' && entry.path.toLowerCase() === '.github') continue;
    entries.set(entry.path, `${entry.type} ${entry.mode} ${entry.sha}`);
  }
  return entries;
};

/**
 * The parent must carry the default tip's protected files exactly. Compared at
 * execution, against the default tip as it is NOW, and before any object is
 * written.
 */
const assertProtectedFilesMatchDefault = async (
  connection: Connection,
  parentSha: string,
  parentTree: string,
  defaultBranch: string,
): Promise<void> => {
  const defaultTip = await GitHubAppService.getBranchHead({ ...gitData(connection), branch: defaultBranch });
  if (typeof defaultTip !== 'string' || !OID.test(defaultTip)) {
    throw new RoomGrantError('base_not_found', 'the default branch was not found in the connected repository', 404);
  }
  if (defaultTip === parentSha) return;
  const defaultTree = await GitHubAppService.getCommitTree({ ...gitData(connection), sha: defaultTip });
  if (defaultTree && defaultTree === parentTree) return;
  const [ours, theirs] = await Promise.all([
    protectedEntriesOf(connection, parentTree),
    protectedEntriesOf(connection, defaultTree),
  ]);
  const same = ours.size === theirs.size && [...ours].every(([path, id]) => theirs.get(path) === id);
  if (!same) {
    throw new RoomGrantError(
      'protected_path_behind_default',
      'the branch carries workflow, action or CODEOWNERS files that differ from the default branch; '
        + 'start a new seat branch from the default branch',
      409,
    );
  }
};

/**
 * Park time: the agent's arguments plus the commit the new one will sit on.
 * A branch that already exists continues from its tip; a new one starts at the
 * base branch's tip.
 */
export const prepareCommitFiles = async (
  raw: Record<string, unknown>,
  connection: Connection,
  agentUserId: string,
): Promise<Record<string, unknown>> => {
  const args = parseCommitFilesArgs(raw, agentUserId);
  const branchHead = await GitHubAppService.getBranchHead({ ...gitData(connection), branch: args.branch });
  if (!branchHead) await assertBaseIsDefault(args.base, connection);
  const parentSha = branchHead || await GitHubAppService.getBranchHead({ ...gitData(connection), branch: args.base });
  if (typeof parentSha !== 'string' || !OID.test(parentSha)) {
    throw new RoomGrantError('base_not_found', 'base branch not found in the connected repository', 404);
  }
  return { ...args, parentSha, branchExists: Boolean(branchHead) };
};

const refRefused = (error: unknown): boolean => {
  const status = Number((error as { response?: { status?: unknown } }).response?.status);
  return status === 409 || status === 422;
};

/** Execution: exactly the approved envelope, onto exactly the approved parent. */
export const commitSeatFiles = async (
  raw: Record<string, unknown>,
  connection: Connection,
  agentUserId: string,
): Promise<Record<string, unknown>> => {
  const args = parseCommitFilesArgs(raw, agentUserId, { allowServerFields: true });
  const { parentSha, branchExists } = raw;
  if (typeof parentSha !== 'string' || !OID.test(parentSha) || typeof branchExists !== 'boolean') {
    // Only an approved envelope carries these; an unparked call cannot run.
    throw invalid('commit has no approved parent');
  }
  const current = await GitHubAppService.getBranchHead({ ...gitData(connection), branch: args.branch });
  if (branchExists ? current !== parentSha : current !== null) {
    throw new RoomGrantError('stale_branch', 'the branch moved since approval; ask again', 409);
  }
  const defaultBranch = await defaultBranchOf(connection);
  // A new branch is held to the default base again: it may have been renamed
  // since the owner approved.
  if (!branchExists && args.base !== defaultBranch) throw baseNotDefault();
  const baseTree = await GitHubAppService.getCommitTree({ ...gitData(connection), sha: parentSha });
  await assertProtectedFilesMatchDefault(connection, parentSha, baseTree, defaultBranch);
  const tree = await GitHubAppService.createTextTree({ ...gitData(connection), baseTree, files: args.files });
  // From here the provider holds something of ours, so a deadline on any
  // remaining step, token mint included, leaves the outcome unknown.
  return sendWrite(async () => {
    const commitSha = await GitHubAppService.createCommit({
      ...gitData(connection), message: args.message, tree, parents: [parentSha],
    });
    try {
      if (branchExists) {
        await GitHubAppService.fastForwardBranchRef({ ...gitData(connection), branch: args.branch, sha: commitSha });
      } else {
        await GitHubAppService.createBranchRef({ ...gitData(connection), branch: args.branch, sha: commitSha });
      }
    } catch (error) {
      // The ref moved between the check above and this write. The commit object
      // is left unreferenced, which GitHub collects; the branch is untouched.
      if (refRefused(error)) throw new RoomGrantError('stale_branch', 'the branch moved since approval; ask again', 409);
      throw error;
    }
    return { branch: args.branch, commitSha, parentSha, files: args.files.length };
  });
};
