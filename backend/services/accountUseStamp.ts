/**
 * F662: on each event served to an own-machine (BYO) seat, say who asked for
 * the turn and whose account answers it, as `payload.accountUse`.
 *
 * A wrapped Claude Code or Codex agent runs every turn on its owner's own login
 * or key. Vendor terms let that serve the owner's own team, not strangers, so
 * the CLI refuses or warns when someone other than the owner starts a turn.
 * It decides on this stamp; the server never refuses here. The rule, the
 * field meanings and the query budget: docs/agents/byo-account-use.md. Contract:
 *
 *   accountUse: {
 *     v: 1,
 *     ownerUserId, ownerName,      // the calling bot's botMetadata.ownerUserId, else its runtime
 *                                  // credential's ownerUserId; and that user's username
 *     requesterUserIds,            // the senders whose words are in the row: a person's id, or an
 *                                  // agent's own bot id (never its owner's); on a typed event,
 *                                  // who started it (TRIGGER_FIELDS: the ruler of a decision,
 *                                  // the approver, the hand-back's agent and acceptor)
 *     requesterKind,               // 'human' | 'agent' | 'kernel' | 'unknown'
 *     pod,                         // { type, publicRead, communityListed, joinPolicy }, or null when the pod is gone
 *     requesterSharesTeamPod,      // DMs only: true | false | null (see below)
 *   }
 *
 * An agent is never the owner, the owner's other agents included. `kernel` is
 * narrow: heartbeats, first contacts and kernel wakes that carry no task text.
 * Assigned-task, board and lease wakes carry text people write, strangers
 * included, so they are `unknown`.
 *
 * `requesterSharesTeamPod` is computed only for an agent-room or agent-dm row
 * that some sender other than the owner wrote. It is true when every such
 * sender (a person's own id, or the sending agent's bot id) shares at least
 * one team pod with the calling bot: not publicRead, not communityListed, and
 * not itself a DM or admin room. It is null on every other row, and when that
 * lookup fails.
 *
 * This runs on the hottest poll in the system, so: a non-BYO caller or an
 * empty page costs no query; any other page costs one `Pod.find` and one
 * `User.find`, both lean and projected, whatever its length. A failure leaves
 * the whole page unstamped (older CLIs and the CLI fallback handle that) and
 * logs one line. A page holding such a DM row costs one `Pod.aggregate` more,
 * for the team-pod check. Nothing here touches enqueue, ack or storage.
 */
import { Types } from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';
import { classifyRuntime } from './agentStateService';
import { podVisibility, PodVisibility } from './podVisibility';
import { describeError } from '../utils/safeErrorLog';

export type RequesterKind = 'human' | 'agent' | 'kernel' | 'unknown';

export interface AccountUse {
  v: 1;
  ownerUserId: string | null;
  ownerName: string | null;
  requesterUserIds: string[];
  requesterKind: RequesterKind;
  pod: ({ type: string | null } & PodVisibility) | null;
  requesterSharesTeamPod: boolean | null;
}

type Row = Record<string, any>;
type ServedEvent = { type?: unknown; podId?: unknown; payload?: Row | null } & Row;

// Rows no person or agent asked for: the kernel woke the agent itself.
const KERNEL_TYPES = new Set(['heartbeat', 'first_contact']);
// Kernel-authored wakes whose content is task or board text people write
// (assignedTaskWakeService, taskEventService). A person's board edit can fold
// into a pending one that keeps `triggerAuthor: 'kernel'`, so these are never
// `kernel`.
const TASK_TEXT_WAKE_FLAGS = ['assignedTaskWake', 'boardWake', 'leaseWarningTaskId'];
// 1:1 rooms: no team boundary of their own, so the CLI asks whether the
// sender shares a team pod with the agent.
const DM_TYPES = new Set(['agent-room', 'agent-dm']);
// Rooms that never count as a shared team pod.
const NOT_TEAM_POD_TYPES = ['agent-room', 'agent-dm', 'agent-admin'];

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const asId = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const id = String(value);
  return OBJECT_ID_RE.test(id) ? id : null;
};

const isTaskTextWake = (event: ServedEvent): boolean => event.payload?.triggerAuthor === 'kernel'
  && TASK_TEXT_WAKE_FLAGS.some((flag) => {
    const value = event.payload?.[flag];
    return value !== undefined && value !== null && value !== false;
  });

const isKernelWake = (event: ServedEvent): boolean => KERNEL_TYPES.has(String(event.type || ''))
  || (event.payload?.triggerAuthor === 'kernel' && !isTaskTextWake(event));

const botKey = (agentName: unknown, instanceId: unknown): string => (
  `${String(agentName || '').toLowerCase()}\u0000${String(instanceId || 'default')}`
);

// The asking agent of an agent.ask: it carries no userId (agentAskService).
const askerOf = (event: ServedEvent): { agentName: string; instanceId: string } | null => {
  const fromAgent = event.payload?.fromAgent;
  if (typeof fromAgent !== 'string' || !fromAgent) return null;
  const fromInstanceId = event.payload?.fromInstanceId;
  return {
    agentName: fromAgent.toLowerCase(),
    instanceId: typeof fromInstanceId === 'string' && fromInstanceId ? fromInstanceId : 'default',
  };
};

const field = (value: unknown, key: string): unknown => (
  value && typeof value === 'object' ? (value as Row)[key] : undefined
);

// Typed events that name who started them in their own field, not userId.
// Each id resolves through the same User lookup as any sender, so a bot id is
// that agent (never its owner) and a missing row is unknown.
//   decision.ruled: the person who ruled (chooseDecision refuses bots).
//   approval.resolved: the person who approved; an expired parked call has none.
//   handback.received: the handing agent's bot id, then the person who accepted.
const TRIGGER_FIELDS: Record<string, (payload: Row) => unknown[]> = {
  'decision.ruled': (payload) => [field(payload.ruledBy, 'userId')],
  'approval.resolved': (payload) => [field(payload.approvedBy, 'userId')],
  'handback.received': (payload) => [field(payload.from, 'agentUserId'), field(payload.acceptedBy, 'userId')],
};

// The sender ids whose words are in the row: its own author, each joined
// message's author (mentionCoalesce.coalescedEntry), and a typed event's
// trigger (TRIGGER_FIELDS). An id that isn't one counts as a sender that
// can't be resolved.
const senderIdsOf = (event: ServedEvent): Array<string | null> => {
  const payload = event.payload || {};
  const ids: Array<string | null> = [];
  if (payload.userId !== undefined && payload.userId !== null) ids.push(asId(payload.userId));
  if (Array.isArray(payload.coalesced)) {
    payload.coalesced.forEach((entry: Row) => ids.push(asId(entry?.userId)));
  }
  const triggers = TRIGGER_FIELDS[String(event.type || '')];
  if (triggers) {
    triggers(payload).forEach((value) => {
      if (value !== undefined && value !== null) ids.push(asId(value));
    });
  }
  return ids;
};

/**
 * Whether this token's seat runs on its owner's own machine, by the rule
 * agentStateService.classifyRuntime uses for liveness: `runtime.host: 'byo'`,
 * a legacy `local-cli`, or the unstamped polling-webhook shape older
 * self-serve and approval-created seats carry (as reportedCli.ts also reads).
 * A token answers for one agent identity, which runs in one place, so any
 * installation of it being BYO makes the poller a BYO seat.
 */
export const isByoSeat = (installations: Row[] | null | undefined): boolean => (
  Array.isArray(installations)
  && installations.some((inst) => Boolean(inst) && classifyRuntime(inst as never).isByo)
);

// A sender as its own user row: a person, or an agent's bot (never mapped to
// its owner). Null when the row is missing: an unresolved sender.
type Sender = { id: string; kind: 'human' | 'agent' } | null;

const buildStamps = async (
  events: ServedEvent[],
  agentUser: Row | null | undefined,
  credential: Row | null | undefined,
): Promise<AccountUse[]> => {
  // botMetadata.ownerUserId is written only for ephemeral installs; issuing a
  // runtime key records the owner on the AgentCredential row, which agent auth
  // has already loaded (req.agentCredential), so the fallback costs no query.
  const ownerUserId = asId(agentUser?.botMetadata?.ownerUserId) || asId(credential?.ownerUserId);

  const podIds = new Set<string>();
  const userIds = new Set<string>();
  const askers = new Map<string, { agentName: string; instanceId: string }>();
  if (ownerUserId) userIds.add(ownerUserId);
  events.forEach((event) => {
    const podId = asId(event.podId);
    if (podId) podIds.add(podId);
    if (isKernelWake(event) || isTaskTextWake(event)) return;
    senderIdsOf(event).forEach((id) => { if (id) userIds.add(id); });
    const asker = askerOf(event);
    if (asker) askers.set(botKey(asker.agentName, asker.instanceId), asker);
  });

  const userFilter: Row[] = [];
  if (userIds.size > 0) userFilter.push({ _id: { $in: [...userIds] } });
  askers.forEach(({ agentName, instanceId }) => {
    userFilter.push({ isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId });
  });

  const [pods, users] = await Promise.all([
    podIds.size > 0
      ? Pod.find({ _id: { $in: [...podIds] } }).select('_id type publicRead communityListed joinPolicy').lean()
      : [],
    userFilter.length > 0
      ? User.find(userFilter.length === 1 ? userFilter[0] : { $or: userFilter })
        .select('_id username isBot botMetadata.agentName botMetadata.instanceId')
        .lean()
      : [],
  ]) as [Row[], Row[]];

  const podById = new Map(pods.map((pod) => [String(pod._id), pod]));
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const botByKey = new Map(users
    .filter((user) => user.isBot === true && user.botMetadata?.agentName)
    .map((user) => [botKey(user.botMetadata.agentName, user.botMetadata.instanceId), user]));

  const ownerName = ownerUserId ? (userById.get(ownerUserId)?.username ?? null) : null;

  // A lean row has no schema defaults; no isBot is a person (User.isBot
  // defaults to false).
  const senderOf = (user: Row | undefined): Sender => (user
    ? { id: String(user._id), kind: user.isBot === true ? 'agent' : 'human' }
    : null);

  const stamps = events.map((event) => {
    const podId = asId(event.podId);
    const pod = podId ? podById.get(podId) : undefined;
    const podFacts = pod
      ? { type: typeof pod.type === 'string' ? pod.type : null, ...(podVisibility(pod) as PodVisibility) }
      : null;
    const base = {
      v: 1 as const, ownerUserId, ownerName, pod: podFacts, requesterSharesTeamPod: null as boolean | null,
    };
    const noSenders: Sender[] = [];

    // Task text with no proven author (v1) is unknown: not the owner, no ids.
    if (isKernelWake(event) || isTaskTextWake(event)) {
      const requesterKind: RequesterKind = isKernelWake(event) ? 'kernel' : 'unknown';
      return { stamp: { ...base, requesterUserIds: [], requesterKind }, nonOwner: noSenders };
    }

    const senders: Sender[] = senderIdsOf(event).map((id) => senderOf(id ? userById.get(id) : undefined));
    const asker = askerOf(event);
    if (asker) senders.push(senderOf(botByKey.get(botKey(asker.agentName, asker.instanceId))));

    const requesterUserIds: string[] = [];
    senders.forEach((sender) => {
      if (sender && !requesterUserIds.includes(sender.id)) requesterUserIds.push(sender.id);
    });
    let requesterKind: RequesterKind;
    if (senders.length === 0 || senders.some((sender) => sender === null)) requesterKind = 'unknown';
    else if (senders.some((sender) => sender?.kind === 'human')) requesterKind = 'human';
    else requesterKind = 'agent';
    // Senders other than the owner, checked for a shared team pod only in a
    // DM. Only the owner's own user id is the owner; an agent never is.
    const nonOwner = podFacts && DM_TYPES.has(String(podFacts.type))
      ? senders.filter((sender) => !ownerUserId || sender?.id !== ownerUserId)
      : noSenders;
    return { stamp: { ...base, requesterUserIds, requesterKind }, nonOwner };
  });

  const checkIds = new Set<string>();
  stamps.forEach(({ nonOwner }) => nonOwner.forEach((sender) => { if (sender) checkIds.add(sender.id); }));
  const anyDmCheck = stamps.some(({ nonOwner }) => nonOwner.length > 0);
  const agentBotId = asId(agentUser?._id);
  if (anyDmCheck) {
    let shared: Set<string> | null = new Set();
    if (!agentBotId) {
      // No bot id, so no lookup can run: the field stays null (not checked),
      // never false (checked, shares nothing).
      shared = null;
    } else if (checkIds.size > 0) {
      try {
        // One aggregate answers which senders share any team pod with this
        // bot, with no limit: each pod is reduced to the senders it holds.
        // Aggregates skip schema casting, so ids go in as ObjectIds.
        const senderObjectIds = [...checkIds].map((id) => new Types.ObjectId(id));
        const hits = await Pod.aggregate([
          {
            $match: {
              $and: [{ members: new Types.ObjectId(agentBotId) }, { members: { $in: senderObjectIds } }],
              publicRead: { $ne: true },
              communityListed: { $ne: true },
              type: { $nin: NOT_TEAM_POD_TYPES },
            },
          },
          { $project: { hit: { $setIntersection: ['$members', senderObjectIds] } } },
          { $unwind: '$hit' },
          { $group: { _id: '$hit' } },
        ]) as Row[];
        hits.forEach((hit) => shared?.add(String(hit._id)));
      } catch (err) {
        console.warn('[account-use] team-pod check failed; left null:', describeError(err).message);
        shared = null;
      }
    }
    stamps.forEach(({ stamp, nonOwner }) => {
      if (nonOwner.length === 0 || shared === null) return;
      // A sender whose row is missing shares nothing it can prove.
      const sharedIds = shared;
      stamp.requesterSharesTeamPod = nonOwner.every((sender) => sender !== null && sharedIds.has(sender.id));
    });
  }
  return stamps.map(({ stamp }) => stamp);
};

/**
 * Stamp `payload.accountUse` on each event of a page served to a BYO seat.
 * Returns the same array; never throws. Other seats, and empty pages, are
 * returned untouched without a query. `credential` is the runtime credential
 * agent auth already loaded (req.agentCredential), for the owner fallback.
 */
export async function stampAccountUse<T extends ServedEvent>(
  events: T[],
  { agentUser, installations, credential }: {
    agentUser?: Row | null; installations?: Row[] | null; credential?: Row | null;
  },
): Promise<T[]> {
  if (!Array.isArray(events) || events.length === 0) return events;
  if (!isByoSeat(installations)) return events;
  try {
    const stamps = await buildStamps(events, agentUser, credential);
    // Assigned only once every stamp is built, so a failure stamps nothing.
    events.forEach((event, i) => {
      if (!event.payload || typeof event.payload !== 'object') event.payload = {};
      (event.payload as Row).accountUse = stamps[i];
    });
  } catch (err) {
    console.warn('[account-use] stamp failed; page served unstamped:', describeError(err).message);
  }
  return events;
}
