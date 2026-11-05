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
 */
import { RoomGrantError } from './roomGrantService';
import { PROTECTED_PATH } from './seatGithubPush';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GitHubAppService = require('./githubAppService');

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
    if (!validPath(path)) throw invalid('a file path is not a plain repository path');
    if (typeof content !== 'string') throw invalid('file content must be text');
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

interface Connection { owner: string; repo: string; installationId: string }

const gitData = (connection: Connection) => ({
  owner: connection.owner,
  repo: connection.repo,
  installationId: connection.installationId,
  forceApp: true,
});

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
  const baseTree = await GitHubAppService.getCommitTree({ ...gitData(connection), sha: parentSha });
  const tree = await GitHubAppService.createTextTree({ ...gitData(connection), baseTree, files: args.files });
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
};
