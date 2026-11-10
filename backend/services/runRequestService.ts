/**
 * F371: approve before run. An owner can ask that anyone else's request to
 * their agent waits for them. The mention path then holds the wake it would
 * have queued, and the owner gets one approval card naming who asked, what they
 * asked and what the agent can reach in the pod. Approve delivers the held
 * wake, narrow delivers it with the owner's rewrite on top, and decline leaves
 * a line beside the request so the person who asked isn't left on silence.
 *
 * The setting is per installation (`config.askBeforeOthers.enabled`), the same
 * scope as the other wake settings, and off unless the owner turns it on.
 * Fails closed: once the owner asked, a request that can't be held is not run.
 */
import { emitRunRequestDeclinedLine } from './systemActionLineService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ApprovalAction = require('../models/ApprovalAction');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');

export const RUN_REQUEST_MAX_LENGTH = 1000;
export const NARROWED_HEADER = '[The owner narrowed this request]';
/** The gate is on but nobody owns the install: refuse, since there is nobody to ask. */
export const UNOWNED = 'unowned';

type InstallRow = {
  agentName?: unknown; instanceId?: unknown; displayName?: unknown;
  installedBy?: unknown; config?: unknown; scopes?: unknown; githubIssueWrite?: unknown;
};
type SenderRow = { isBot?: boolean; botMetadata?: unknown } | null;
export type HeldEvent = {
  agentName: string; instanceId: string; podId: string; type: string; payload: Record<string, unknown>;
};

const configOf = (install: InstallRow): Record<string, any> => {
  const { config } = install;
  if (config instanceof Map) return Object.fromEntries(config.entries());
  return config && typeof config === 'object' ? config as Record<string, any> : {};
};

export const asksBeforeOthers = (install: InstallRow): boolean => configOf(install).askBeforeOthers?.enabled === true;

/**
 * The person an install answers to: its installer when that's a human, else
 * the bot's owner. `installedBy` holds the bot itself on some install paths
 * (agentMentionService's note on it), so it is checked, never trusted.
 */
export const ownerOfInstall = async (install: InstallRow): Promise<string | null> => {
  if (install.installedBy) {
    const installer = await User.findById(install.installedBy).select('isBot').lean() as { isBot?: boolean } | null;
    if (installer && installer.isBot === false) return String(install.installedBy);
  }
  const agent = await User.findOne({
    isBot: true,
    'botMetadata.agentName': String(install.agentName || '').toLowerCase(),
    'botMetadata.instanceId': String(install.instanceId || 'default'),
  }).select('botMetadata').lean() as { botMetadata?: { ownerUserId?: unknown } } | null;
  return agent?.botMetadata?.ownerUserId ? String(agent.botMetadata.ownerUserId) : null;
};

/**
 * The owner whose approval this sender's request needs, or null when it runs
 * straight away. An agent's request counts as its owner's, so a person can't
 * route around the gate through their own agent on the mention or ask paths
 * (an agent-dm is a stated limit, docs/agents/ask-before-others.md). An owner that can't be found
 * gets UNOWNED: the setting is on, so the request is refused, never run.
 */
export const approverFor = async (
  install: InstallRow, sender: SenderRow, senderUserId: string,
): Promise<string | null> => {
  if (!asksBeforeOthers(install)) return null;
  const owner = await ownerOfInstall(install);
  if (!owner) return UNOWNED;
  const botOwner = (sender?.botMetadata as { ownerUserId?: unknown } | undefined)?.ownerUserId;
  const asker = sender?.isBot ? String(botOwner || '') : String(senderUserId || '');
  return asker && asker === owner ? null : owner;
};

// Reach codes, which the card words in the viewer's language. A scope with no
// code is passed through as itself, so a new grant shows rather than hides.
const SCOPE_REACH: Record<string, string> = {
  'messages:read': 'pod:read',
  'context:read': 'pod:read',
  'summaries:read': 'pod:read',
  'posts:read': 'pod:read',
  'messages:write': 'pod:post',
  'posts:write': 'pod:post',
  'memory:read': 'memory:read',
  'memory:write': 'memory:write',
};

/**
 * What the agent can reach here, from its install's grants. It is what the
 * agent is allowed to touch, not a forecast of what this request will do. An
 * install with no scopes listed can still read and post in its pod.
 */
export const reachOf = (install: InstallRow): string[] => {
  const scopes = Array.isArray(install.scopes) ? install.scopes.map(String) : [];
  const reach = new Set<string>();
  scopes.forEach((scope) => reach.add(SCOPE_REACH[scope] || scope));
  if (install.githubIssueWrite === true) reach.add('github:issues');
  return reach.size ? Array.from(reach) : ['pod:read', 'pod:post'];
};

export const holdRunRequest = async ({
  install, event, ownerUserId, requesterUserId, requesterName, request, threadRootId,
}: {
  install: InstallRow;
  event: HeldEvent;
  ownerUserId: string;
  requesterUserId: string;
  requesterName: string;
  request: string;
  threadRootId?: string | null;
}): Promise<boolean | 'pending'> => {
  const agentName = String(install.agentName || event.agentName).toLowerCase();
  const instanceId = String(install.instanceId || event.instanceId || 'default');
  const displayName = String(install.displayName || agentName);
  const open = await ApprovalAction.findOne({
    podId: event.podId, agentName, instanceId, actionType: 'run_request', status: 'flagged',
    'params.requesterUserId': requesterUserId,
  }).select('_id').lean();
  if (open) return 'pending';
  const pod = await Pod.findById(event.podId).select('name').lean() as { name?: string } | null;
  const row = await ApprovalAction.create({
    podId: event.podId,
    ownerUserId,
    agentName,
    instanceId,
    actionType: 'run_request',
    params: {
      requesterUserId,
      requesterName,
      request: String(request || '').slice(0, RUN_REQUEST_MAX_LENGTH),
      podName: pod?.name || '',
      reach: reachOf(install),
    },
    heldEvent: { type: event.type, payload: event.payload },
    summary: `${requesterName} asked ${displayName} to run a request`.slice(0, 500),
  });

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { buildCardPayload } = require('./approvalActionService');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentMessageService = require('./agentMessageService');
  let posted: { success?: boolean; message?: { _id?: unknown; id?: unknown } } | null = null;
  try {
    posted = await AgentMessageService.postMessage({
      agentName,
      instanceId,
      displayName,
      podId: String(event.podId),
      messageType: 'card',
      approvalCard: true,
      payload: buildCardPayload(row),
      // No request text here: the card renders it from params, and the
      // content line stays a plain label wherever messages are listed.
      content: `[approval needed] ${row.summary}`,
      metadata: { source: 'approval-card', approvalId: String(row._id) },
      ...(threadRootId ? { threadRootId } : {}),
      skipSummaryPersistence: true,
    });
  } catch (error) {
    console.warn('[run-request] card post failed:', (error as Error).message);
  }
  if (!posted?.success || !posted?.message) {
    row.status = 'moot';
    await row.save();
    return false;
  }
  row.messageId = String(posted.message._id || posted.message.id || '');
  await row.save();
  // eslint-disable-next-line global-require
  const { recordActionApproval } = require('./attentionItemService');
  await recordActionApproval(row, displayName);
  return true;
};

/** The approve executor: deliver the held wake, with the owner's rewrite on top when narrowed. */
export const releaseRunRequest = async (
  row: {
    _id: unknown; agentName: string; instanceId?: string; podId: unknown;
    heldEvent?: { type: string; payload: Record<string, unknown> };
  },
  approver: { name: string; narrowedTo?: string | null },
): Promise<{ delivered: true; narrowed: boolean }> => {
  if (!row.heldEvent?.type) throw new Error('the held request is missing');
  const narrowed = typeof approver.narrowedTo === 'string' && approver.narrowedTo.trim().length > 0;
  const payload: Record<string, unknown> = {
    ...row.heldEvent.payload, runRequestId: String(row._id), approvedBy: approver.name,
  };
  // The asker's own words can't carry the owner's header: only the real one,
  // written below, reads as the owner's.
  const unforged = (text: unknown) => String(text ?? '').split(NARROWED_HEADER).join('[header removed]');
  payload.content = unforged(payload.content);
  if (typeof payload.rawContent === 'string') payload.rawContent = unforged(payload.rawContent);
  if (narrowed) {
    const version = String(approver.narrowedTo).trim();
    payload.content = [
      NARROWED_HEADER,
      `${approver.name} approved only this version, so do only this:\n${version}`,
      '',
      String(payload.content || ''),
    ].join('\n');
    // F109 programs read rawContent, so it carries the version the owner approved.
    payload.originalRawContent = payload.rawContent;
    payload.rawContent = version;
    payload.narrowedTo = version;
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentEventService = require('./agentEventService');
  await AgentEventService.enqueue({
    agentName: row.agentName,
    instanceId: row.instanceId || 'default',
    podId: String(row.podId),
    type: row.heldEvent.type,
    payload,
  });
  return { delivered: true, narrowed };
};

/** The decline note, beside the request it answers. Never fatal: the decision already stands. */
export const noteRunRequestDeclined = async (
  row: { podId: unknown; ownerUserId: unknown; agentName: string; params?: Record<string, unknown>;
    heldEvent?: { payload?: Record<string, unknown> } },
  owner: { name: string; username?: string },
  agentLabel: string,
): Promise<void> => {
  try {
    const held = row.heldEvent?.payload || {};
    await emitRunRequestDeclinedLine({
      podId: String(row.podId),
      actorUserId: String(row.ownerUserId),
      actorUsername: owner.username || owner.name,
      actorAvatarUrl: null,
      actorIsBot: false,
      ownerName: owner.name,
      requesterName: String(row.params?.requesterName || 'Someone'),
      agentLabel,
      messageId: (held.messageId as string | undefined) ?? null,
      threadRootId: (held.threadRootId as string | undefined) ?? null,
    });
  } catch (error) {
    console.warn('[run-request] decline note failed:', (error as Error).message);
  }
};

export default {
  asksBeforeOthers, ownerOfInstall, approverFor, reachOf, holdRunRequest, releaseRunRequest, noteRunRequestDeclined,
};
// CJS compat: let require() return the default export directly
module.exports = exports["default"]; Object.assign(module.exports, exports);
