/**
 * Scout's welcome "Run an agent here", run on click (TASK-290).
 *
 * The signup welcome is the one message whose hosted start runs in place: one
 * click installs and starts a Commonly-hosted agent in the person's own
 * workspace, with no Bring your own page in between (walk 5 spent ~10 s
 * there). The click is the consent. Every other hosted offer, Scout's
 * commonly_offer_hosted_agent included, keeps its link to that page.
 *
 * Which message is the welcome is decided by who posted it, never by a field
 * in it: the author must be the Scout this person installed in a pod they
 * created. The `action` in the payload only asks to run in place; these checks
 * decide whether it may, both when the thread is read and when the click
 * arrives. A start that fails them keeps its link, which works as before.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const HostedRuntime = require('./hostedRuntimeService');

export const WELCOME_HOSTED_START_ID = 'run-hosted';
export const WELCOME_HOSTED_ACTION = 'run-hosted';

interface StartLike {
  id?: unknown;
  action?: unknown;
  [key: string]: unknown;
}

interface MessageLike {
  id?: unknown;
  pod_id?: unknown;
  user_id?: unknown;
  payload?: unknown;
}

const startsOf = (payload: unknown): StartLike[] | null => {
  const p = payload as { kind?: unknown; starts?: unknown } | null | undefined;
  if (!p || p.kind !== 'starts' || !Array.isArray(p.starts)) return null;
  return p.starts as StartLike[];
};

const isHostedAction = (start: StartLike | null | undefined): boolean => Boolean(
  start && start.id === WELCOME_HOSTED_START_ID && start.action === WELCOME_HOSTED_ACTION,
);

/** Whether a message payload asks for the hosted start to run in place. */
export const offersWelcomeHostedAction = (payload: unknown): boolean => (
  (startsOf(payload) || []).some(isHostedAction)
);

/**
 * The bot User id of the Scout this person installed in a pod they created,
 * or null. A pod someone else created, or one with no Scout of theirs, has no
 * welcome this person may run.
 */
export const workspaceScoutUserId = async (podId: unknown, userId: unknown): Promise<string | null> => {
  const uid = String(userId || '');
  const pid = String(podId || '');
  if (!uid || !pid) return null;
  const pod = await Pod.findById(pid).select('createdBy').lean();
  if (!pod || String(pod.createdBy || '') !== uid) return null;
  const scout = await AgentInstallation.findOne({
    agentName: 'scout',
    podId: pid,
    installedBy: uid,
    status: 'active',
  }).select('instanceId').lean();
  if (!scout) return null;
  const bot = await User.findOne({
    username: AgentIdentityService.buildAgentUsername('scout', String(scout.instanceId || 'default')),
    isBot: true,
  }).select('_id').lean();
  return bot?._id ? String(bot._id) : null;
};

/**
 * Read-side gate for a page of pod messages. A hosted start keeps its action
 * only on this viewer's own welcome; anywhere else the action and owner plan
 * caps are dropped and the start keeps its link. Pages with no such start pass
 * through untouched and cost no lookup.
 */
export const gateWelcomeHostedActions = async <T extends MessageLike>(
  messages: T[],
  podId: unknown,
  userId: unknown,
): Promise<T[]> => {
  if (!Array.isArray(messages) || !messages.some((m) => offersWelcomeHostedAction(m?.payload))) return messages;
  const scoutId = await workspaceScoutUserId(podId, userId).catch(() => null);
  return messages.map((message) => {
    if (!offersWelcomeHostedAction(message.payload)) return message;
    if (scoutId && String(message.user_id ?? '') === scoutId) return message;
    const payload = message.payload as Record<string, unknown>;
    const starts = (startsOf(payload) || []).map((start) => {
      if (!isHostedAction(start)) return start;
      const { action: _action, caps: _caps, ...rest } = start;
      return rest;
    });
    return { ...message, payload: { ...payload, starts } };
  });
};

export type WelcomeHostedStartResult =
  | { error: { status: number; body: { code: string; message: string } } }
  | {
    podId: string;
    // The hosted agent this person already holds. A second click, or a click
    // in a second tab, gets the same agent back instead of a second install.
    existing: { agentName: string; instanceId: string; podId: string } | null;
    // A free name for a new install in the welcome's pod; null when existing.
    agentName: string | null;
  };

const notWelcome = (): WelcomeHostedStartResult => ({
  error: {
    status: 403,
    body: { code: 'not_welcome_start', message: 'This start can only be run from your own workspace welcome' },
  },
});

/**
 * What one click on the welcome's hosted start should start: the hosted agent
 * this person already holds, or a free name to install in the welcome's pod.
 * The install itself goes through POST /api/registry/install, which stays the
 * only authority on what may be installed (cap, names, identity).
 */
export const resolveWelcomeHostedStart = async (
  { messageId, userId }: { messageId: unknown; userId: unknown },
): Promise<WelcomeHostedStartResult> => {
  // Pod chat lives in Postgres, where a message id is a serial integer.
  const id = String(messageId ?? '');
  if (!/^\d{1,15}$/.test(id)) {
    return { error: { status: 400, body: { code: 'invalid_message_id', message: 'messageId is required' } } };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PGMessage = require('../models/pg/Message').default;
  const message = await PGMessage.findById(id).catch(() => null) as MessageLike | null;
  if (!message || !offersWelcomeHostedAction(message.payload)) return notWelcome();
  const scoutId = await workspaceScoutUserId(message.pod_id, userId);
  if (!scoutId || String(message.user_id ?? '') !== scoutId) return notWelcome();

  const podId = String(message.pod_id);
  const [held] = await HostedRuntime.listHostedInstallationsForUser(userId);
  if (held) return { podId, existing: held, agentName: null };

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { suggestLocalAgentName } = require('./approvalActionService');
  const agentName = await suggestLocalAgentName('agent', userId);
  if (!agentName) {
    return {
      error: {
        status: 409,
        body: {
          code: 'agent_name_unavailable',
          message: 'No free agent name was found; choose one on the Bring your own page',
        },
      },
    };
  }
  return { podId, existing: null, agentName };
};
