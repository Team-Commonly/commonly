import { randomUUID } from 'crypto';
import Pod from '../models/Pod';
import Integration from '../models/Integration';
import RoomGrant, { IRoomGrant, RoomGrantWriteMode } from '../models/RoomGrant';
import ToolCall, { digestArgs, reserveBudgetLineage } from '../models/ToolCall';
import {
  assertGrantToolAllowed,
  assertGrantUsable,
  getGrantLineage,
  RoomGrantError,
} from './roomGrantService';
import { GRANT_BROKER_REFUSAL_CODE } from './grantBrokerConfinement';
import { SessionAccountRefusal, loadSessionAccount, sessionRefusal } from './sessionAccountService';
import { judgeSeatConfinement } from './seatGrantConfinement';
import { findHostedToolDefinition, hostedToolDefinitions } from './hostedMcpToolDefinitions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GitHubAppService = require('./githubAppService');

export interface ToolDefinitionBase {
  name: string;
  description: string;
  requiredWriteMode: RoomGrantWriteMode;
  irreversible?: boolean | ((args: Record<string, unknown>) => boolean);
  inputSchema: Record<string, unknown>;
}

/** A connection to an installed GitHub App: the tenant a call runs against. */
export interface GithubToolConnection {
  type: 'github-app';
  installationId: string;
  owner: string;
  repo: string;
  ownerUserId?: string;
}

/**
 * A connection to a hosted-MCP Connection row. It names the ROW that holds the
 * credential rather than carrying a token, because the token is fetched inside
 * the tool's `call` (§4): a seat listing its tools must not trigger a refresh,
 * and a call that never happens must not spend one.
 */
export interface HostedToolConnection {
  type: 'hosted-mcp';
  entryId: string;
  connectionId: string;
  ownerUserId?: string;
}

/** What a tool is handed. Discriminated on `type` — narrow before reading a field. */
export type ToolConnection = GithubToolConnection | HostedToolConnection;

export interface GithubToolDefinition extends ToolDefinitionBase {
  connectionType: 'github-app';
  /** Enrich the canonical approval payload with provider state captured now. */
  prepareApproval?: (
    args: Record<string, unknown>,
    connection: GithubToolConnection,
  ) => Promise<Record<string, unknown>>;
  call: (args: Record<string, unknown>, connection: GithubToolConnection) => Promise<unknown>;
}

/**
 * A hosted-MCP tool. `entryId` is the catalogue entry it was projected from,
 * and `call` is built by `hostedMcpToolDefinitions` — the only module that
 * knows how to reach a vendor.
 */
export interface HostedToolDefinition extends ToolDefinitionBase {
  connectionType: 'hosted-mcp';
  entryId: string;
  call: (args: Record<string, unknown>, connection: HostedToolConnection) => Promise<unknown>;
}

export type ToolDefinition = GithubToolDefinition | HostedToolDefinition;

export interface BrokerCallInput {
  grantId: string;
  agentUserId: string;
  agentName?: string;
  instanceId?: string;
  tool: string;
  args?: unknown;
  /**
   * Set only by the native runtime's in-process dispatch
   * (`grantBrokerProjectionService.dispatchHostedBrokerTool`). A hosted turn has
   * no shell, web or file tools, so it has nothing for a sandbox to confine and
   * the seat-confinement refusal does not apply to it (Wren, TASK-175 74882).
   *
   * Named for the TURN and not the connection: a caller may hold a hosted
   * connection and still be a shelled seat, which is a different question and
   * one this flag must not answer.
   */
  hostedTurn?: boolean;
}

export interface BrokerCallResult {
  callId: string;
  result: unknown;
  outcome: 'ok' | 'failed';
}

const issueView = (issue: Record<string, unknown>): Record<string, unknown> => ({
  number: issue.number,
  title: issue.title,
  body: issue.body || '',
  url: issue.html_url,
  labels: Array.isArray(issue.labels)
    ? issue.labels.map((label: unknown) => String((label as Record<string, unknown>)?.name || label))
    : [],
  milestone: issue.milestone && typeof issue.milestone === 'object'
    ? String((issue.milestone as Record<string, unknown>).title || '') || null
    : null,
});

const pullView = (pull: Record<string, unknown>): Record<string, unknown> => ({
  number: pull.number,
  title: pull.title,
  body: pull.body || '',
  url: pull.html_url,
  state: pull.state,
  merged: pull.merged,
  base: pull.base && typeof pull.base === 'object'
    ? String((pull.base as Record<string, unknown>).ref || '') : undefined,
  head: pull.head && typeof pull.head === 'object'
    ? String((pull.head as Record<string, unknown>).ref || '') : undefined,
});

const objectArgs = (args: unknown): Record<string, unknown> => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new RoomGrantError('invalid_tool_args', 'tool arguments must be an object', 400);
  }
  return args as Record<string, unknown>;
};

const assertNoUnknown = (args: Record<string, unknown>, allowed: string[]): void => {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new RoomGrantError('invalid_tool_args', `unknown tool argument: ${unknown[0]}`, 400);
  }
};

const positiveInteger = (value: unknown, field: string, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new RoomGrantError('invalid_tool_args', `${field} must be a positive integer`, 400);
  }
  return Number(value);
};

const nonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RoomGrantError('invalid_tool_args', `${field} is required`, 400);
  }
  return value.trim();
};

// Approval envelopes bind the provider destination as well as the visible
// tool arguments. These fields are server-owned metadata: the executor
// validates them against the current connection, then removes them before
// invoking the provider so an approved envelope can never steer the call.
const pinConnectionRepository = (
  rawArgs: Record<string, unknown>,
  connection: GithubToolConnection,
): Record<string, unknown> => ({
  ...rawArgs,
  owner: connection.owner,
  repo: connection.repo,
});

const providerArgsFromApprovedEnvelope = (
  args: Record<string, unknown>,
  connection: GithubToolConnection,
): Record<string, unknown> => {
  if (args.owner !== connection.owner || args.repo !== connection.repo) {
    throw new RoomGrantError('repo_mismatch', 'connected repository changed since approval', 409);
  }
  const { owner: _owner, repo: _repo, ...providerArgs } = args;
  return providerArgs;
};

const listIssues: GithubToolDefinition = {
  name: 'github.list_issues',
  description: 'List open issues in this instance\'s GitHub repository.',
  requiredWriteMode: 'read',
  connectionType: 'github-app',
  inputSchema: {
    type: 'object',
    properties: { perPage: { type: 'integer', minimum: 1, maximum: 100 } },
    additionalProperties: false,
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['perPage']);
    const perPage = positiveInteger(rawArgs.perPage, 'perPage', 20);
    if (perPage > 100) throw new RoomGrantError('invalid_tool_args', 'perPage must be at most 100', 400);
    const issues = await GitHubAppService.listOpenIssues({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      perPage,
    });
    return { issues: (issues || []).map((issue: Record<string, unknown>) => issueView(issue)) };
  },
};

const createIssue: GithubToolDefinition = {
  name: 'github.create_issue',
  description: 'Create an issue in this instance\'s GitHub repository.',
  requiredWriteMode: 'write-with-confirm',
  connectionType: 'github-app',
  irreversible: true,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      body: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async prepareApproval(rawArgs, connection) {
    return pinConnectionRepository(rawArgs, connection);
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['title', 'body', 'labels']);
    const title = nonEmptyString(rawArgs.title, 'title');
    if (rawArgs.body !== undefined && typeof rawArgs.body !== 'string') {
      throw new RoomGrantError('invalid_tool_args', 'body must be a string', 400);
    }
    if (rawArgs.labels !== undefined
      && (!Array.isArray(rawArgs.labels) || rawArgs.labels.some((label) => typeof label !== 'string'))) {
      throw new RoomGrantError('invalid_tool_args', 'labels must be an array of strings', 400);
    }
    const issue = await GitHubAppService.createIssue({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      title,
      body: rawArgs.body as string | undefined,
      labels: rawArgs.labels as string[] | undefined,
    });
    return issueView(issue as Record<string, unknown>);
  },
};

const getIssue: GithubToolDefinition = {
  name: 'github.get_issue',
  description: 'Fetch one issue from this instance\'s GitHub repository.',
  requiredWriteMode: 'read',
  connectionType: 'github-app',
  inputSchema: {
    type: 'object',
    properties: { issueNumber: { type: 'integer', minimum: 1 } },
    required: ['issueNumber'],
    additionalProperties: false,
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['issueNumber']);
    const issue = await GitHubAppService.getIssue({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      issueNumber: positiveInteger(rawArgs.issueNumber, 'issueNumber'),
    });
    return issueView(issue as Record<string, unknown>);
  },
};

const getPullRequest: GithubToolDefinition = {
  name: 'github.get_pull_request',
  description: 'Fetch one pull request from this instance\'s GitHub repository.',
  requiredWriteMode: 'read',
  connectionType: 'github-app',
  inputSchema: {
    type: 'object',
    properties: { pullNumber: { type: 'integer', minimum: 1 } },
    required: ['pullNumber'],
    additionalProperties: false,
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['pullNumber']);
    const pull = await GitHubAppService.getPullRequest({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      pullNumber: positiveInteger(rawArgs.pullNumber, 'pullNumber'),
    });
    return pullView(pull as Record<string, unknown>);
  },
};

const listPullRequestFiles: GithubToolDefinition = {
  name: 'github.list_pull_request_files',
  description: 'List files changed by a pull request in this instance\'s GitHub repository.',
  requiredWriteMode: 'read',
  connectionType: 'github-app',
  inputSchema: {
    type: 'object',
    properties: { pullNumber: { type: 'integer', minimum: 1 } },
    required: ['pullNumber'],
    additionalProperties: false,
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['pullNumber']);
    const files = await GitHubAppService.listPullRequestFiles({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      pullNumber: positiveInteger(rawArgs.pullNumber, 'pullNumber'),
    });
    return {
      files: (files || []).map((file: Record<string, unknown>) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        url: file.blob_url,
      })),
    };
  },
};

const commentIssue: GithubToolDefinition = {
  name: 'github.comment_on_issue',
  description: 'Add a comment to an issue in this instance\'s GitHub repository.',
  requiredWriteMode: 'write-with-confirm',
  connectionType: 'github-app',
  irreversible: true,
  inputSchema: {
    type: 'object',
    properties: { issueNumber: { type: 'integer', minimum: 1 }, body: { type: 'string', minLength: 1 } },
    required: ['issueNumber', 'body'],
    additionalProperties: false,
  },
  async prepareApproval(rawArgs, connection) {
    return pinConnectionRepository(rawArgs, connection);
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['issueNumber', 'body']);
    const issueNumber = positiveInteger(rawArgs.issueNumber, 'issueNumber');
    const body = nonEmptyString(rawArgs.body, 'body');
    const result = await GitHubAppService.addIssueComment({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      issueNumber,
      body,
    });
    const comment = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
    return { id: comment.id, url: comment.html_url, issueNumber };
  },
};

const closeIssue: GithubToolDefinition = {
  name: 'github.close_issue',
  description: 'Close an issue in this instance\'s GitHub repository.',
  requiredWriteMode: 'write-with-confirm',
  connectionType: 'github-app',
  // Closing an issue is reversible (it can be reopened). Agent text is a
  // separate comment tool so the approval tier is not argument-dependent.
  inputSchema: {
    type: 'object',
    properties: {
      issueNumber: { type: 'integer', minimum: 1 },
    },
    required: ['issueNumber'],
    additionalProperties: false,
  },
  async prepareApproval(rawArgs, connection) {
    return pinConnectionRepository(rawArgs, connection);
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['issueNumber']);
    const issueNumber = positiveInteger(rawArgs.issueNumber, 'issueNumber');
    const issue = await GitHubAppService.closeIssue({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      issueNumber,
    });
    return issueView(issue as Record<string, unknown>);
  },
};

const mergePullRequest: GithubToolDefinition = {
  name: 'github.merge_pull_request',
  description: 'Merge a pull request in this instance\'s GitHub repository.',
  requiredWriteMode: 'write-with-confirm',
  connectionType: 'github-app',
  irreversible: true,
  inputSchema: {
    type: 'object',
    properties: {
      pullNumber: { type: 'integer', minimum: 1 },
      mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      commitTitle: { type: 'string' },
      commitMessage: { type: 'string' },
    },
    required: ['pullNumber'],
    additionalProperties: false,
  },
  async prepareApproval(rawArgs, connection) {
    const pullNumber = positiveInteger(rawArgs.pullNumber, 'pullNumber');
    const pull = await GitHubAppService.getPullRequest({
      owner: connection.owner,
      repo: connection.repo,
      installationId: connection.installationId,
      forceApp: true,
      pullNumber,
    }) as Record<string, unknown>;
    const head = pull?.head && typeof pull.head === 'object'
      ? pull.head as Record<string, unknown>
      : undefined;
    const headSha = typeof head?.sha === 'string' ? head.sha.trim() : '';
    if (!headSha) {
      throw new RoomGrantError('merge_head_unavailable', 'pull request head SHA is unavailable', 409);
    }
    return pinConnectionRepository({ ...rawArgs, pullNumber, headSha }, connection);
  },
  async call(rawArgs, connection) {
    assertNoUnknown(rawArgs, ['pullNumber', 'mergeMethod', 'commitTitle', 'commitMessage', 'headSha']);
    const mergeMethod = rawArgs.mergeMethod;
    if (mergeMethod !== undefined && !['merge', 'squash', 'rebase'].includes(String(mergeMethod))) {
      throw new RoomGrantError('invalid_tool_args', 'mergeMethod must be merge, squash, or rebase', 400);
    }
    for (const field of ['commitTitle', 'commitMessage']) {
      if (rawArgs[field] !== undefined && typeof rawArgs[field] !== 'string') {
        throw new RoomGrantError('invalid_tool_args', `${field} must be a string`, 400);
      }
    }
    const headSha = nonEmptyString(rawArgs.headSha, 'headSha');
    let merged: unknown;
    try {
      merged = await GitHubAppService.mergePullRequest({
        owner: connection.owner,
        repo: connection.repo,
        installationId: connection.installationId,
        forceApp: true,
        pullNumber: positiveInteger(rawArgs.pullNumber, 'pullNumber'),
        mergeMethod: mergeMethod as 'merge' | 'squash' | 'rebase' | undefined,
        commitTitle: rawArgs.commitTitle as string | undefined,
        commitMessage: rawArgs.commitMessage as string | undefined,
        sha: headSha,
      });
    } catch (error) {
      const status = (error as { response?: { status?: unknown }; statusCode?: unknown }).response?.status
        || (error as { statusCode?: unknown }).statusCode;
      if (Number(status) === 409) {
        throw new RoomGrantError('merge_head_mismatch', 'pull request head changed since approval', 409);
      }
      throw error;
    }
    const result = (merged && typeof merged === 'object') ? merged as Record<string, unknown> : {};
    return {
      merged: result.merged,
      sha: result.sha,
      message: result.message,
    };
  },
};

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  [listIssues.name]: listIssues,
  [getIssue.name]: getIssue,
  [getPullRequest.name]: getPullRequest,
  [listPullRequestFiles.name]: listPullRequestFiles,
  [createIssue.name]: createIssue,
  [commentIssue.name]: commentIssue,
  [closeIssue.name]: closeIssue,
  [mergePullRequest.name]: mergePullRequest,
};

/**
 * The tools that ship with the broker, and only those. Named for what it is
 * rather than what it returns: `toolInstallables` validates a GitHub grant's
 * tools against this list, and a hosted name must not make that gate pass.
 */
export const getToolDefinitions = (): ToolDefinition[] => Object.values(TOOL_DEFINITIONS);

/**
 * Every definition a seat can be offered or call: the seeded GitHub record plus
 * every hosted catalogue entry's projection. The two surfaces that answer "what
 * may this seat do" (`listToolsForGrant`, and the runtime projection) read this
 * one, so a hosted grant cannot be visible on one and invisible on the other.
 */
export const allToolDefinitions = (): ToolDefinition[] => [
  ...getToolDefinitions(),
  ...hostedToolDefinitions(),
];

const currentMemberIds = async (grant: IRoomGrant | Record<string, unknown>): Promise<string[]> => {
  const target = (grant as Record<string, unknown>).target as { kind?: string; id?: string } | undefined;
  if (!target?.kind || !target.id) throw new RoomGrantError('invalid_target', 'grant target is invalid', 403);
  if (target.kind === 'seat') {
    // A seat grant can authorize exactly its target seat. Do not treat a
    // malformed audience list as a live-membership source for another agent.
    return [String(target.id)];
  }
  const pod = await Pod.findById(target.id).select('members').lean();
  if (!pod) throw new RoomGrantError('target_not_found', 'target pod not found', 404);
  return (pod.members || []).map((member) => String(member));
};

/**
 * Milliseconds for a document's `createdAt`, or null when the value cannot be
 * read as a timestamp. Both models declare `timestamps: true`, so a missing or
 * unreadable value means the row was written outside the model — the one case
 * an `a && b && c` comparison would wave through.
 */
const createdAtMs = (value: unknown): number | null => {
  const time = value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(time) ? time : null;
};

/**
 * The `hosted-mcp` half of `resolveConnection`, kept beside it so the two
 * branches are read together: both end in a connection a tool can run against,
 * or a refusal with the same codes.
 *
 * A hosted grant's connection id is the Connection row's `_id` — the row has
 * neither of the GitHub installation-id slots — so the lookup is by `_id` and
 * never by an external id a later row could reuse.
 */
const resolveHostedConnection = async (
  grant: IRoomGrant | Record<string, unknown>,
  definition: HostedToolDefinition,
  connectionId: string,
): Promise<HostedToolConnection> => {
  if (!/^[a-f\d]{24}$/i.test(connectionId)) {
    throw new RoomGrantError('connection_mismatch', 'grant connection is not a hosted-MCP Connection', 403);
  }
  const row = await Integration.findById(connectionId).lean() as unknown as {
    type?: string;
    status?: string;
    revokedAt?: Date | null;
    createdBy?: unknown;
    createdAt?: unknown;
    config?: { entryId?: unknown };
  } | null;
  if (!row || row.type !== 'hosted-mcp' || row.status !== 'connected' || row.revokedAt) {
    throw new RoomGrantError(
      'connection_mismatch',
      'grant connection is not a connected hosted-MCP Connection',
      403,
    );
  }
  // The tool list a definition carries comes from ONE entry, so a connection
  // whose row names another entry cannot pay for this call. `resolveBrokerFor`
  // keyed the mint on the row's entry for the same reason (§7).
  const entryId = String(row.config?.entryId || '');
  if (!entryId || entryId !== definition.entryId) {
    throw new RoomGrantError(
      'connection_mismatch',
      'grant connection does not belong to this tool\'s entry',
      403,
    );
  }
  const grantCreatedAt = createdAtMs((grant as { createdAt?: unknown }).createdAt);
  const rowCreatedAt = createdAtMs(row.createdAt);
  if (grantCreatedAt === null || rowCreatedAt === null) {
    throw new RoomGrantError(
      'connection_untracked',
      'grant or connection row has no creation timestamp',
      403,
    );
  }
  if (grantCreatedAt < rowCreatedAt) {
    throw new RoomGrantError(
      'connection_superseded',
      'grant predates the connection row it resolves to',
      403,
    );
  }
  const ownerUserId = row.createdBy ? String(row.createdBy) : undefined;
  await assertHostedOwnerUsable(ownerUserId);
  return {
    type: 'hosted-mcp',
    entryId,
    connectionId,
    // The member who connected the row, so a parked call can open the approval
    // room for a seat-targeted grant (`resolveApprovalPodId`).
    ownerUserId,
  };
};

/**
 * A hosted row is authorised by the PERSON who connected it, so a ban has to
 * reach the credential and not only the sign-in (TASK-181). A suspended person
 * cannot sign in (`middleware/auth.ts`), but an agent acting on their connection
 * never signs in as them: it presents its own runtime token and the broker spends
 * the owner's stored credential, so the ban stopped nothing at all. Both broker
 * paths — the MCP endpoint and the in-process native runtime — funnel through
 * `resolveHostedConnection`, so the check lives here rather than in a driver.
 *
 * The predicate is read through `sessionAccountService`, the one live-row read
 * every session verifier shares (`loadSessionAccount` + `sessionRefusal`). That
 * is not a style preference: a verifier that recomputes the predicate reads
 * `undefined` for a field it forgot to project and refuses NOTHING, which is
 * exactly how a bot-owned row would slip through a `select('banned')` check.
 *
 * HOSTED ONLY. A `github-app` row's token belongs to the app installation, not
 * to the admin who created the row, so suspending that admin must not disable the
 * app connector for every pod holding a grant on it (§7).
 *
 * The id-shape test is not the predicate: it keeps a value that cannot name an
 * account away from `findById`, whose CastError would otherwise reach the caller
 * as a 500. A row with no owner at all is `missing` — it has no person behind it,
 * and the remedy (remove the row) is the one that code names.
 */
const HOSTED_OWNER_REFUSALS: Record<SessionAccountRefusal, string> = {
  banned: 'connection_owner_banned',
  missing: 'connection_owner_missing',
  bot: 'connection_owner_bot',
};

const HOSTED_OWNER_MESSAGES: Record<SessionAccountRefusal, string> = {
  banned: 'the person who connected this connection is suspended',
  missing: 'the person who connected this connection no longer exists',
  bot: 'this connection is owned by a bot account, which cannot be its granter',
};

const assertHostedOwnerUsable = async (ownerUserId?: string): Promise<void> => {
  const ownerId = String(ownerUserId ?? '').trim();
  // Only a value that names an account is carried onto the ledger: a malformed
  // one names nobody, and the column is read as an owner id.
  const accountId = /^[a-f\d]{24}$/i.test(ownerId) ? ownerId : undefined;
  const refusal = accountId
    ? sessionRefusal(await loadSessionAccount(accountId))
    : 'missing';
  if (!refusal) return;
  throw new RoomGrantError(
    HOSTED_OWNER_REFUSALS[refusal],
    HOSTED_OWNER_MESSAGES[refusal],
    403,
    accountId ? { credentialOwnerId: accountId } : undefined,
  );
};

const resolveConnection = async (
  grant: IRoomGrant | Record<string, unknown>,
  definition: ToolDefinition,
): Promise<ToolConnection> => {
  const connectionId = String((grant as Record<string, unknown>).connectionId || '').trim();
  if (!connectionId) throw new RoomGrantError('connection_mismatch', 'grant connection is missing', 403);
  if (definition.connectionType === 'hosted-mcp') {
    return resolveHostedConnection(grant, definition, connectionId);
  }
  let connection = await Integration.findOne({ type: definition.connectionType, installationId: connectionId });
  // Grants commonly retain the Mongo connection _id. Avoid putting an
  // untrusted string into a BSON _id selector when it is not an ObjectId.
  if (!connection && /^[a-f\d]{24}$/i.test(connectionId)) {
    connection = await Integration.findById(connectionId);
  }
  const row = connection as unknown as {
    type?: string;
    status?: string;
    revokedAt?: Date | null;
    createdBy?: unknown;
    createdAt?: unknown;
    config?: { installationId?: string; owner?: string; repo?: string };
  } | null;
  const config = row?.config;
  if (
    !row
    || row.type !== definition.connectionType
    || row.status !== 'connected'
    || row.revokedAt
    || !config?.installationId
    || !config.owner
    || !config.repo
  ) {
    throw new RoomGrantError('connection_mismatch', 'grant connection is not a connected GitHub App installation', 403);
  }

  // A grant outlives the row it was minted for as soon as that row is deleted
  // and the same installation is added again: `connectionId` holds the
  // installation id, so the re-added row resolves the old grant (TASK-148,
  // #1922's C9 gap). Compare creation times instead of trusting the match —
  // the row a grant belongs to always predates the grant.
  //
  // Both sides are required. The population this guard exists for IS the
  // anomalous row, so an `a && b && c` test would pass exactly the rows it is
  // meant to refuse; refusal is the only safe reading of an absent timestamp.
  const grantCreatedAt = createdAtMs((grant as { createdAt?: unknown }).createdAt);
  const rowCreatedAt = createdAtMs(row.createdAt);
  if (grantCreatedAt === null || rowCreatedAt === null) {
    throw new RoomGrantError(
      'connection_untracked',
      'grant or connection row has no creation timestamp',
      403,
    );
  }
  if (grantCreatedAt < rowCreatedAt) {
    throw new RoomGrantError(
      'connection_superseded',
      'grant predates the connection row it resolves to',
      403,
    );
  }

  return {
    type: 'github-app',
    installationId: String(config.installationId),
    owner: String(config.owner),
    repo: String(config.repo),
    ownerUserId: row.createdBy ? String(row.createdBy) : undefined,
  };
};

/**
 * The grant-load preamble every broker path needs: the grant is read fresh, so
 * revocation and membership are never cached. Membership is deliberately NOT
 * part of this load — `currentMemberIds` can refuse (`invalid_target`,
 * `target_not_found`) and each caller must run its own cheap checks first, in
 * the order it already had.
 */
const loadGrantForAgent = async (input: {
  grantId: string;
  agentUserId: string;
}): Promise<IRoomGrant | Record<string, unknown>> => {
  if (!input.agentUserId) throw new RoomGrantError('agent_identity_required', 'agent identity is required', 403);
  const grant = (await RoomGrant.findOne({ grantId: input.grantId })) || undefined;
  if (!grant) throw new RoomGrantError('grant_not_found', 'grant not found', 404);
  return grant;
};

/**
 * The definitions a grant may actually call, for the MCP `tools/list` surface.
 * Listing has to answer what calling would allow and no more, so it runs the
 * same checks `callTool` runs instead of a second copy of them: the grant-level
 * checks through `assertGrantUsable` (existence, revocation, expiry, lineage,
 * audience), then the per-tool rule through the same `assertGrantToolAllowed`
 * that function delegates to. Names are matched raw — the sanitized spelling
 * `grantBrokerProjectionService` uses exists for LiteLLM function names, and
 * this surface calls tools by definition name.
 *
 * A grant whose connection no longer resolves refuses here too, with the code
 * the call would give, rather than offering tools every call would reject.
 *
 * Deliberate boundary: the list reflects the grant and its connection, not
 * per-call spend state (`budget_exhausted`). Spend is re-checked on every call
 * and is not a property of the grant.
 */
export const listToolsForGrant = async (input: {
  grantId: string;
  agentUserId: string;
  agentName?: string;
  instanceId?: string;
}): Promise<ToolDefinition[]> => {
  const grant = await loadGrantForAgent(input);
  await assertGrantUsable({
    grant,
    agentUserId: input.agentUserId,
    currentMemberIds: await currentMemberIds(grant),
  });
  // A list is a capability disclosure, and the refusal covers the list as well
  // as the call: a seat that may not use the grant must not be handed its tool
  // definitions (TASK-146's rule, now for the seat's own confinement).
  await assertSeatCanConfine(input);

  const allowed = allToolDefinitions().filter((definition) => {
    try {
      assertGrantToolAllowed(grant, {
        tool: definition.name,
        requiredWriteMode: definition.requiredWriteMode,
      });
      return true;
    } catch {
      return false;
    }
  });

  // One resolution per connection type: the row is a property of the grant, not
  // of the individual tool, and the refusal code (`connection_superseded`, ...)
  // is the same for every tool on it.
  const byConnectionType = new Map<string, ToolDefinition>();
  for (const definition of allowed) {
    if (!byConnectionType.has(definition.connectionType)) byConnectionType.set(definition.connectionType, definition);
  }
  for (const definition of byConnectionType.values()) await resolveConnection(grant, definition);

  return allowed;
};

/**
 * Refuse the call when the CALLING SEAT's own declaration cannot confine a
 * broker (TASK-175). The same predicate the grant read reports and the server
 * projection applies, resolved through the same projection, so the endpoint
 * cannot judge a seat differently from the way the daemon delivers it.
 *
 * It runs before any tool work — before the connection is resolved, the
 * approval parked, or a budget line spent — because a refusal is not a
 * spendable call; the shared catch trails it `refused`.
 */
const assertSeatCanConfine = async (input: {
  agentName?: string;
  instanceId?: string;
  agentUserId: string;
  hostedTurn?: boolean;
}): Promise<void> => {
  if (input.hostedTurn) return;
  const judgement = await judgeSeatConfinement({
    agentName: input.agentName,
    instanceId: input.instanceId,
    agentUserId: input.agentUserId,
  });
  if (!judgement.refusal) return;
  throw new RoomGrantError(
    GRANT_BROKER_REFUSAL_CODE,
    judgement.refusal.detail,
    403,
    { reason: judgement.refusal.reason, decidedBy: judgement.refusal.decidedBy },
  );
};

/**
 * Approval cards share the grant's target audience. A pod grant can post to
 * that pod directly; a seat grant must use the private room between the
 * granter and the seat so no third party can observe its credentials or
 * approval arguments.
 */
const resolveApprovalPodId = async (
  grant: IRoomGrant | Record<string, unknown>,
  connection: ToolConnection,
  agentName?: string,
  instanceId?: string,
): Promise<string> => {
  const target = (grant as Record<string, unknown>).target as { kind?: string; id?: string } | undefined;
  if (!target?.kind || !target.id) {
    throw new RoomGrantError('invalid_target', 'grant target is invalid', 403);
  }
  if (target.kind !== 'seat') return String(target.id);
  if (!connection.ownerUserId) {
    throw new RoomGrantError('connection_mismatch', 'grant connection owner is missing', 403);
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const DMService = require('./dmService');
  const room = await DMService.getOrCreateAgentRoom(
    String(target.id),
    connection.ownerUserId,
    { agentName: agentName || 'grant-broker', instanceId: instanceId || 'default' },
  );
  if (!room?._id) {
    throw new RoomGrantError('approval_unavailable', 'approval room could not be created', 503);
  }
  return String(room._id);
};

/**
 * The connection as a provider sees it: enough to run against, and not the
 * connecting member's user id. Both members are rebuilt field by field rather
 * than spread, so a field added to a connection later cannot reach a provider
 * without this line being read.
 */
const providerConnection = (connection: ToolConnection): ToolConnection => (connection.type === 'hosted-mcp'
  ? { type: 'hosted-mcp', entryId: connection.entryId, connectionId: connection.connectionId }
  : {
    type: 'github-app',
    installationId: connection.installationId,
    owner: connection.owner,
    repo: connection.repo,
  });

const asGithubConnection = (connection: ToolConnection): GithubToolConnection => {
  if (connection.type !== 'github-app') {
    throw new RoomGrantError('connection_mismatch', 'grant connection is not a GitHub App installation', 403);
  }
  return connection;
};

const asHostedConnection = (connection: ToolConnection): HostedToolConnection => {
  if (connection.type !== 'hosted-mcp') {
    throw new RoomGrantError('connection_mismatch', 'grant connection is not a hosted-MCP Connection', 403);
  }
  return connection;
};

/**
 * Run a definition against a resolved connection. The pair is discriminated
 * here so a definition can only receive its own connection shape: a hosted tool
 * handed a GitHub connection (or the reverse) refuses with the code
 * `resolveConnection` uses, instead of reading fields that are not there.
 */
const runDefinition = (
  definition: ToolDefinition,
  args: Record<string, unknown>,
  connection: ToolConnection,
): Promise<unknown> => {
  const provider = providerConnection(connection);
  return definition.connectionType === 'hosted-mcp'
    ? definition.call(args, asHostedConnection(provider))
    : definition.call(args, asGithubConnection(provider));
};

/**
 * The canonical arguments an approval envelope should be judged on. GitHub's
 * envelope carries server-owned repository fields that the executor re-validates
 * and strips; a hosted tool has no such fields, so its arguments are the
 * member's own and pass through untouched.
 */
const prepareApprovalFor = (
  definition: ToolDefinition,
  args: Record<string, unknown>,
  connection: ToolConnection,
): Promise<Record<string, unknown>> => {
  if (definition.connectionType === 'hosted-mcp') return Promise.resolve(args);
  if (!definition.prepareApproval) return Promise.resolve(args);
  return definition.prepareApproval(args, asGithubConnection(providerConnection(connection)));
};

/** The definition a tool name resolves to: the seeded GitHub record, or a hosted catalogue entry. */
const lookupToolDefinition = (name: string): ToolDefinition | undefined => (
  TOOL_DEFINITIONS[name] || findHostedToolDefinition(name)
);

const safeReason = (error: unknown): string => {
  if (error instanceof RoomGrantError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.length <= 255) return code;
  return 'broker_error';
};

const executionErrorOutcome = (error: unknown): 'refused' | 'failed' | 'pending_approval' => {
  if (!(error instanceof RoomGrantError)) return 'failed';
  if (error.code === 'approval_required') return 'pending_approval';
  if (error.code === 'provider_error' || error.code === 'provider_unreachable') return 'failed';
  return 'refused';
};

/**
 * Whose credential a refused call would have spent (scope §8, TASK-181).
 *
 * Both catches below record `credentialOwnerId` from a local that is filled the
 * moment `resolveConnection` returns — but the owner refusals happen INSIDE that
 * call, so without this the one trail row whose REASON names the owner is the
 * one row that does not say who they were, and "which suspended person's
 * connection was this" is unanswerable from the ledger. The guard knows the id
 * at the moment it refuses, so it carries it on the error and the catch prefers
 * it. It runs only after the row is proven the grant's own, so the proof-failing
 * refusals carry nothing and still record nobody; a refusal that happens before
 * anything resolves (`tool_not_found`, a grant that does not load) has nothing
 * to name either.
 */
const refusedCredentialOwner = (
  error: unknown,
  resolved: string | undefined,
): string | undefined => (
  error instanceof RoomGrantError && typeof error.details?.credentialOwnerId === 'string'
    ? error.details.credentialOwnerId
    : resolved
);

const recordCall = async (
  input: BrokerCallInput,
  grant: IRoomGrant | Record<string, unknown> | undefined,
  outcome: 'ok' | 'refused' | 'failed' | 'pending_approval',
  startedAt: number,
  reason?: string,
  overrides?: {
    callId?: string;
    approvalId?: string;
    args?: unknown;
    /**
     * The Connection's owner, supplied by the BROKER from the row it resolved
     * (`connection.ownerUserId`) — never by the caller, which is why it sits
     * here rather than in `BrokerCallInput`. A record names the owner only once
     * the row is PROVEN the grant's own: the proof-failing refusals
     * (`connection_mismatch`, `connection_untracked`, `connection_superseded`)
     * name nobody — a superseded row is the re-added one, whose `createdBy`
     * never made the grant — and neither does a refusal that never reached a
     * connection at all. The owner refusals run AFTER that proof, so they carry
     * their id on the error (see `refusedCredentialOwner`).
     */
    credentialOwnerId?: string;
  },
): Promise<string> => {
  const callId = overrides?.callId || `tool_call_${randomUUID()}`;
  await ToolCall.create({
    callId,
    grantId: input.grantId,
    podId: grant ? String(((grant as Record<string, unknown>).target as { id?: string })?.id || '') : undefined,
    installationId: grant ? String((grant as Record<string, unknown>).installationId || '') : undefined,
    agentUserId: input.agentUserId,
    credentialOwnerId: overrides?.credentialOwnerId,
    tool: input.tool,
    argsDigest: digestArgs(overrides?.args === undefined ? input.args : overrides.args),
    at: new Date(startedAt),
    outcome,
    reason,
    approvalId: overrides?.approvalId,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  return callId;
};

/** A resolved MCP tool error is an executed call that failed at the provider. */
const isToolErrorResult = (result: unknown): boolean => (
  Boolean(result)
  && typeof result === 'object'
  && !Array.isArray(result)
  && (result as { isError?: unknown }).isError === true
);

/** Keep both execution paths' trail semantics in one place. */
const recordExecutionResult = async (
  input: BrokerCallInput,
  grant: IRoomGrant | Record<string, unknown> | undefined,
  result: unknown,
  startedAt: number,
  overrides?: {
    callId?: string;
    approvalId?: string;
    args?: unknown;
    credentialOwnerId?: string;
  },
): Promise<{ callId: string; outcome: 'ok' | 'failed' }> => {
  const upstreamToolError = isToolErrorResult(result);
  const outcome = upstreamToolError ? 'failed' : 'ok';
  const callId = await recordCall(
    input,
    grant,
    outcome,
    startedAt,
    upstreamToolError ? 'upstream_tool_error' : undefined,
    overrides,
  );
  return { callId, outcome };
};

const budgetEntriesFor = async (
  grant: IRoomGrant | Record<string, unknown>,
): Promise<Array<{ grantId: string; calls: number; windowMs?: number }>> => {
  const lineage = await getGrantLineage(grant);
  return lineage.reverse().flatMap((item) => {
    const budget = (item as Record<string, unknown>).budget as { calls?: number; windowMs?: number } | undefined;
    if (budget?.calls === undefined) return [];
    return [{
      grantId: String((item as Record<string, unknown>).grantId),
      calls: budget.calls,
      windowMs: budget.windowMs,
    }];
  });
};

/**
 * Execute one brokered tool call. The only identity accepted here is the
 * middleware-derived agentUserId; a request argument with that name is never
 * consulted. Membership is loaded for every call so leavers lose access.
 */
export const callTool = async (input: BrokerCallInput): Promise<BrokerCallResult> => {
  const startedAt = Date.now();
  const definition = lookupToolDefinition(input.tool);
  let grant: IRoomGrant | Record<string, unknown> | undefined;
  // Whose credential ran (scope §8). Filled the moment the connection resolves,
  // so the refusals and failures below record it too. A refusal that happens
  // before anything resolves leaves it unset — except an owner refusal, which
  // names the owner on the error and is preferred by the catch.
  let credentialOwnerId: string | undefined;

  try {
    grant = await loadGrantForAgent({ grantId: input.grantId, agentUserId: input.agentUserId });
    if (!definition) throw new RoomGrantError('tool_not_found', 'tool is not registered', 404);

    const members = await currentMemberIds(grant);
    await assertGrantUsable({
      grant,
      agentUserId: input.agentUserId,
      currentMemberIds: members,
      tool: definition.name,
      // Required mode comes only from this server-side definition map.
      requiredWriteMode: definition.requiredWriteMode,
    });
    await assertSeatCanConfine(input);

    const connection = await resolveConnection(grant, definition);
    credentialOwnerId = connection.ownerUserId;

    // Validate the shape before reserving a budget slot; malformed requests
    // are refusals, not spendable calls.
    const parsedArgs = objectArgs(input.args);

    const irreversible = typeof definition.irreversible === 'function'
      ? definition.irreversible(parsedArgs)
      : definition.irreversible === true;
    // Confirmation is a floor set by the tool: every irreversible operation
    // parks for a human, including when the grant is otherwise full `write`.
    // A `write-with-confirm` grant also confirms every write; full `write`
    // alone is the tier that permits reversible writes to run unattended.
    const requiresConfirmation = irreversible
      || (grant.writeMode === 'write-with-confirm' && definition.requiredWriteMode !== 'read');
    if (requiresConfirmation) {
      const callId = `tool_call_${randomUUID()}`;
      // No guard on `prepareApproval`: the helper answers for both members, and
      // a hosted tool's arguments are simply its own.
      const canonicalArgs = await prepareApprovalFor(definition, parsedArgs, connection);
      let proposal: { ok: boolean; approvalId?: string } | undefined;
      try {
        const approvalPodId = await resolveApprovalPodId(
          grant,
          connection,
          input.agentName,
          input.instanceId,
        );
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const approvalService = require('./approvalActionService');
        proposal = await approvalService.proposeAction({
          podId: approvalPodId,
          agentName: input.agentName || 'grant-broker',
          instanceId: input.instanceId || 'default',
          actionType: 'tool_call',
          params: {},
          summary: `${definition.description} (approval required)`,
          ownerUserId: connection.ownerUserId,
          agentUserId: input.agentUserId,
          toolCall: {
            grantId: String((grant as Record<string, unknown>).grantId || input.grantId),
            callId,
            tool: definition.name,
            canonicalArgs,
            argsDigest: digestArgs(canonicalArgs),
            // The parked envelope carries the credential owner so the record the
            // DECISION writes (approvalActionService) keeps naming it, even if
            // the Connection row is gone by then (§8).
            credentialOwnerId: connection.ownerUserId,
          },
        });
      } catch (error) {
        // A proposal failure must never leave a pending ledger row with no
        // approval id. Record the refusal immediately, then surface the same
        // fail-closed error as the explicit `{ ok: false }` branch below.
        //
        // A cause that is already a `RoomGrantError` keeps its own code and
        // status. `resolveApprovalPodId` refuses with `connection_mismatch` or
        // `invalid_target` — both permanent 403s — and relabelling them
        // `approval_unavailable` told the caller to retry something that can
        // never succeed while the ledger recorded a reason that was not the
        // cause. Only an unclassified failure, such as the approval store
        // being unavailable, is `approval_unavailable`.
        const cause = error instanceof RoomGrantError
          ? error
          : new RoomGrantError('approval_unavailable', 'approval card could not be created', 503);
        const refusedCallId = await recordCall(input, grant, 'refused', startedAt, cause.code, {
          callId,
          args: canonicalArgs,
          credentialOwnerId,
        });
        throw new RoomGrantError(cause.code, cause.message, cause.statusCode, {
          recorded: true,
          callId: refusedCallId,
        });
      }
      if (proposal && !proposal.ok) {
        await recordCall(input, grant, 'refused', startedAt, 'approval_unavailable', {
          callId,
          args: canonicalArgs,
          credentialOwnerId,
        });
        throw new RoomGrantError('approval_unavailable', 'approval card could not be created', 503, {
          recorded: true,
          callId,
        });
      }
      await recordCall(input, grant, 'pending_approval', startedAt, 'approval_required', {
        callId,
        approvalId: proposal?.approvalId,
        args: canonicalArgs,
        credentialOwnerId,
      });
      const approvalError = new RoomGrantError(
        'approval_required',
        'tool call requires approval',
        403,
        {
          approvalId: proposal?.approvalId,
          callId,
          recorded: true,
        },
      );
      throw approvalError;
    }

    const budgetEntries = await budgetEntriesFor(grant);
    if (budgetEntries.length > 0) {
      const reserved = await reserveBudgetLineage(budgetEntries);
      if (!reserved) throw new RoomGrantError('budget_exhausted', 'grant call budget is exhausted', 403);
    }

    const result = await runDefinition(definition, parsedArgs, connection);
    const recorded = await recordExecutionResult(
      input,
      grant,
      result,
      startedAt,
      { credentialOwnerId },
    );
    return { ...recorded, result };
  } catch (error) {
    const reason = safeReason(error);
    // Audit refusals and failures with the token-derived identity. If the
    // audit store itself is unavailable, surface that failure rather than
    // claiming a call happened without a durable trail.
    const outcome = executionErrorOutcome(error);
    const alreadyRecorded = error instanceof RoomGrantError && Boolean(error.details?.recorded);
    const callId = alreadyRecorded
      ? String(error.details?.callId || '')
      : await recordCall(input, grant, outcome, startedAt, reason, {
        credentialOwnerId: refusedCredentialOwner(error, credentialOwnerId),
      });
    if (error instanceof RoomGrantError) {
      Object.assign(error, { details: { ...(error.details || {}), ...(callId ? { callId } : {}) } });
    }
    throw error;
  }
};

export interface ApprovedToolCallInput {
  grantId: string;
  agentUserId: string;
  tool: string;
  args: Record<string, unknown>;
  expectedArgsDigest: string;
  approvalId: string;
}

/** Execute the exact envelope captured by an approval winner. This path never
 * consults request arguments and never re-parks; all normal grant, audience,
 * connection and budget checks still run immediately before the provider. */
export const executeApprovedToolCall = async (
  input: ApprovedToolCallInput,
): Promise<BrokerCallResult> => {
  const startedAt = Date.now();
  const definition = lookupToolDefinition(input.tool);
  let grant: IRoomGrant | Record<string, unknown> | undefined;
  const callId = `tool_call_${randomUUID()}`;
  // Whose credential ran (scope §8), filled when the connection resolves — the
  // parked envelope carries the same value, so a decision after the row's
  // deletion still names the owner. An owner refusal happens inside that
  // resolution and carries its id on the error; the catch prefers it.
  let credentialOwnerId: string | undefined;
  try {
    if (!definition) throw new RoomGrantError('tool_not_found', 'tool is not registered', 404);
    if (digestArgs(input.args) !== input.expectedArgsDigest) {
      throw new RoomGrantError('args_digest_mismatch', 'approved tool arguments no longer match', 409);
    }
    grant = (await RoomGrant.findOne({ grantId: input.grantId })) || undefined;
    if (!grant) throw new RoomGrantError('grant_not_found', 'grant not found', 404);
    const members = await currentMemberIds(grant);
    await assertGrantUsable({
      grant,
      agentUserId: input.agentUserId,
      currentMemberIds: members,
      tool: definition.name,
      requiredWriteMode: definition.requiredWriteMode,
    });
    const connection = await resolveConnection(grant, definition);
    credentialOwnerId = connection.ownerUserId;
    const executionArgs = definition.connectionType === 'github-app'
      ? providerArgsFromApprovedEnvelope(input.args, asGithubConnection(connection))
      : input.args;
    const budgetEntries = await budgetEntriesFor(grant);
    if (budgetEntries.length > 0 && !await reserveBudgetLineage(budgetEntries)) {
      throw new RoomGrantError('budget_exhausted', 'grant call budget is exhausted', 403);
    }
    const result = await runDefinition(definition, executionArgs, connection);
    const recorded = await recordExecutionResult(
      { grantId: input.grantId, agentUserId: input.agentUserId, tool: input.tool, args: input.args },
      grant,
      result,
      startedAt,
      { callId, approvalId: input.approvalId, args: input.args, credentialOwnerId },
    );
    return { ...recorded, result };
  } catch (error) {
    const reason = safeReason(error);
    await recordCall(
      { grantId: input.grantId, agentUserId: input.agentUserId, tool: input.tool, args: input.args },
      grant,
      executionErrorOutcome(error),
      startedAt,
      reason,
      {
        callId,
        approvalId: input.approvalId,
        args: input.args,
        credentialOwnerId: refusedCredentialOwner(error, credentialOwnerId),
      },
    );
    throw error;
  }
};

// Exported for route tests and for the MCP catalogue projection.
export default {
  callTool,
  executeApprovedToolCall,
  allToolDefinitions,
  getToolDefinitions,
  listToolsForGrant,
  TOOL_DEFINITIONS,
};

// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
