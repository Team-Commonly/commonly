import { randomUUID } from 'crypto';
import Pod from '../models/Pod';
import Integration from '../models/Integration';
import RoomGrant, { IRoomGrant, RoomGrantWriteMode } from '../models/RoomGrant';
import ToolCall, { digestArgs, reserveBudgetLineage } from '../models/ToolCall';
import {
  assertGrantUsable,
  getGrantLineage,
  RoomGrantError,
} from './roomGrantService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GitHubAppService = require('./githubAppService');

export interface ToolDefinition {
  name: string;
  description: string;
  requiredWriteMode: RoomGrantWriteMode;
  connectionType: 'github-app';
  irreversible?: boolean | ((args: Record<string, unknown>) => boolean);
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, connection: ToolConnection) => Promise<unknown>;
}

export interface ToolConnection {
  type: 'github-app';
  installationId: string;
  owner: string;
  repo: string;
}

export interface BrokerCallInput {
  grantId: string;
  agentUserId: string;
  tool: string;
  args?: unknown;
}

export interface BrokerCallResult {
  callId: string;
  result: unknown;
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

const listIssues: ToolDefinition = {
  name: 'github.list_issues',
  description: 'List open issues in the Commonly repository.',
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

const createIssue: ToolDefinition = {
  name: 'github.create_issue',
  description: 'Create an issue in the Commonly repository.',
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

const getIssue: ToolDefinition = {
  name: 'github.get_issue',
  description: 'Fetch one issue from the Commonly repository.',
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

const getPullRequest: ToolDefinition = {
  name: 'github.get_pull_request',
  description: 'Fetch one pull request from the Commonly repository.',
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

const listPullRequestFiles: ToolDefinition = {
  name: 'github.list_pull_request_files',
  description: 'List files changed by a pull request in the Commonly repository.',
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

const commentIssue: ToolDefinition = {
  name: 'github.comment_on_issue',
  description: 'Add a comment to an issue in the Commonly repository.',
  requiredWriteMode: 'write-with-confirm',
  connectionType: 'github-app',
  irreversible: true,
  inputSchema: {
    type: 'object',
    properties: { issueNumber: { type: 'integer', minimum: 1 }, body: { type: 'string', minLength: 1 } },
    required: ['issueNumber', 'body'],
    additionalProperties: false,
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

const closeIssue: ToolDefinition = {
  name: 'github.close_issue',
  description: 'Close an issue in the connected GitHub repository.',
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

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  [listIssues.name]: listIssues,
  [getIssue.name]: getIssue,
  [getPullRequest.name]: getPullRequest,
  [listPullRequestFiles.name]: listPullRequestFiles,
  [createIssue.name]: createIssue,
  [commentIssue.name]: commentIssue,
  [closeIssue.name]: closeIssue,
};

export const getToolDefinitions = (): ToolDefinition[] => Object.values(TOOL_DEFINITIONS);

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

const resolveConnection = async (
  grant: IRoomGrant | Record<string, unknown>,
  definition: ToolDefinition,
): Promise<ToolConnection> => {
  const connectionId = String((grant as Record<string, unknown>).connectionId || '').trim();
  if (!connectionId) throw new RoomGrantError('connection_mismatch', 'grant connection is missing', 403);
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
  return {
    type: 'github-app',
    installationId: String(config.installationId),
    owner: String(config.owner),
    repo: String(config.repo),
  };
};

const safeReason = (error: unknown): string => {
  if (error instanceof RoomGrantError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.length <= 255) return code;
  return 'broker_error';
};

const recordCall = async (
  input: BrokerCallInput,
  grant: IRoomGrant | Record<string, unknown> | undefined,
  outcome: 'ok' | 'refused' | 'failed' | 'pending_approval',
  startedAt: number,
  reason?: string,
): Promise<string> => {
  const callId = `tool_call_${randomUUID()}`;
  await ToolCall.create({
    callId,
    grantId: input.grantId,
    podId: grant ? String(((grant as Record<string, unknown>).target as { id?: string })?.id || '') : undefined,
    installationId: grant ? String((grant as Record<string, unknown>).installationId || '') : undefined,
    agentUserId: input.agentUserId,
    tool: input.tool,
    argsDigest: digestArgs(input.args),
    at: new Date(startedAt),
    outcome,
    reason,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  return callId;
};

/**
 * Execute one brokered tool call. The only identity accepted here is the
 * middleware-derived agentUserId; a request argument with that name is never
 * consulted. Membership is loaded for every call so leavers lose access.
 */
export const callTool = async (input: BrokerCallInput): Promise<BrokerCallResult> => {
  const startedAt = Date.now();
  const definition = TOOL_DEFINITIONS[input.tool];
  let grant: IRoomGrant | Record<string, unknown> | undefined;

  try {
    if (!input.agentUserId) throw new RoomGrantError('agent_identity_required', 'agent identity is required', 403);
    grant = (await RoomGrant.findOne({ grantId: input.grantId })) || undefined;
    if (!grant) throw new RoomGrantError('grant_not_found', 'grant not found', 404);
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

    const connection = await resolveConnection(grant, definition);

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
      throw new RoomGrantError('approval_required', 'irreversible tool call requires approval', 403);
    }

    const lineage = await getGrantLineage(grant);
    const budgetEntries = lineage.reverse().flatMap((item) => {
      const budget = (item as Record<string, unknown>).budget as { calls?: number; windowMs?: number } | undefined;
      if (budget?.calls === undefined) return [];
      return [{
        grantId: String((item as Record<string, unknown>).grantId),
        calls: budget.calls,
        windowMs: budget.windowMs,
      }];
    });
    if (budgetEntries.length > 0) {
      const reserved = await reserveBudgetLineage(budgetEntries);
      if (!reserved) throw new RoomGrantError('budget_exhausted', 'grant call budget is exhausted', 403);
    }

    const result = await definition.call(parsedArgs, connection);
    const callId = await recordCall(input, grant, 'ok', startedAt);
    return { callId, result };
  } catch (error) {
    const reason = safeReason(error);
    // Audit refusals and failures with the token-derived identity. If the
    // audit store itself is unavailable, surface that failure rather than
    // claiming a call happened without a durable trail.
    const outcome = error instanceof RoomGrantError
      ? (error.code === 'approval_required' ? 'pending_approval' : 'refused')
      : 'failed';
    const callId = await recordCall(input, grant, outcome, startedAt, reason);
    if (error instanceof RoomGrantError) {
      Object.assign(error, { details: { ...(error.details || {}), callId } });
    }
    throw error;
  }
};

// Exported for route tests and for the MCP catalogue projection.
export default { callTool, getToolDefinitions, TOOL_DEFINITIONS };

// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
