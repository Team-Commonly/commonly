/**
 * ADR-037 (F654): review before the PR, and a hand-back a named teammate
 * accepts or refuses.
 *
 * An agent sends a plan to one named person (plan-send). Once that person
 * accepts it, the agent does the work and hands back what was asked, planned,
 * changed, checked and left unverified (hand-back). The same person accepts or
 * refuses that with a reason, and on accept an optional next agent receives
 * `handback.received` carrying all five fields.
 *
 * User space on the kernel: the record is the `hand_backs` table
 * (repositories/handBackRepository.ts), and each review is an ordinary
 * decision card driven through decisionRequestService, with the four ADR-037
 * card extensions and a `hand_back` subject whose stage check and on-ruled
 * hook this module registers at boot (registerHandBackSubject, server.ts).
 *
 * The Mongo card is the source of truth for a verdict. Its copy into the
 * record (applyRuling) is a compare-and-set that every read and a scheduler
 * sweep repeat, so a failed copy is caught up and never doubled.
 */
import crypto from 'crypto';
import { registerDecisionSubject } from './decisionSubjectRegistry';
import type { HandBackRecord, HandBackRuling, HandBackStatus } from '../repositories/handBackRepository';

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const repo = require('../repositories/handBackRepository');
const DecisionRequest = require('../models/DecisionRequest');
const Pod = require('../models/Pod');
const User = require('../models/User');
const Task = require('../models/Task');
const AgentEvent = require('../models/AgentEvent');
const { AgentInstallation } = require('../models/AgentRegistry');
const { isListedPodMember } = require('../utils/isPodMember');
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

export const SUBJECT_TYPE = 'hand_back';

export class HandBackError extends Error {
  status: number;

  code: string;

  detail?: Record<string, unknown>;

  constructor(message: string, status: number, code: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// The record's own text caps (ADR-037 §8 leaves them to this PR). The cards
// reuse DecisionRequest's question (1000) and context (2000) limits and show a
// bounded summary; the full record is what the hand-back card renders.
export const CAPS = {
  askedText: 2000,
  plan: 4000,
  listItems: 20,
  itemText: 500,
} as const;

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const CHANGED_KINDS = ['pr', 'commit', 'file', 'message', 'url'] as const;
// agentAnswerService.WAKE_TYPES: the event types that wake an agent on a message.
const WAKE_TYPES = ['chat.mention', 'thread.mention', 'message.posted'];
const DM_POD_TYPES = new Set(['agent-room', 'agent-dm']);
const VERDICTS = ['Accept', 'Refuse'] as const;
const CARD_VALUES = VERDICTS.map((value) => ({ value, reasonRequired: true }));
// How long a withdrawn record's card is re-checked by the sweep.
const WITHDRAWN_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
// The sweep retries an unstamped handback.received only after this long, so
// the ruling's own writer has time to enqueue and stamp it first.
const RECEIVED_GRACE_MS = 2 * 60 * 1000;
// How long a record may wait for its card's id before recovery treats the
// card post as failed. A post is one chat write and one Mongo insert, each
// bounded by its driver's timeouts (well under a minute together), so five
// minutes is far past any post still in flight: recovery never undoes a post
// that could still land. A card that does land later finds its record moved
// and is closed by its poster (attachPostedCard).
const CARD_POST_GRACE_MS = 5 * 60 * 1000;

const fail = (message: string, status: number, code: string, detail?: Record<string, unknown>): never => {
  throw new HandBackError(message, status, code, detail);
};

const text = (value: unknown, field: string, max: number, { required = true } = {}): string => {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`, 400, 'invalid_hand_back', { field });
    return '';
  }
  if (typeof value !== 'string') return fail(`${field} must be a string`, 400, 'invalid_hand_back', { field });
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${field} is required`, 400, 'invalid_hand_back', { field });
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters`, 400, 'invalid_hand_back', { field });
  return trimmed;
};

const plainObject = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${field} must be an object`, 400, 'invalid_hand_back', { field });
  }
  return value as Record<string, unknown>;
};

const closedKeys = (value: Record<string, unknown>, allowed: string[], field: string): void => {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`Unsupported ${field} fields: ${extra.join(', ')}`, 400, 'unsupported_fields', { field, extra });
};

const list = <T>(
  value: unknown, field: string, { min = 0 }: { min?: number }, item: (raw: Record<string, unknown>, index: number) => T,
): T[] => {
  if (!Array.isArray(value)) return fail(`${field} must be an array`, 400, 'invalid_hand_back', { field });
  if (value.length < min || value.length > CAPS.listItems) {
    fail(`${field} must have ${min} to ${CAPS.listItems} entries`, 400, 'invalid_hand_back', { field });
  }
  return value.map((raw, index) => item(plainObject(raw, `${field}[${index}]`), index));
};

const bound = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

const isHuman = (user: any): boolean => Boolean(user && !user.isBot);

const usersById = async (ids: Array<string | null | undefined>): Promise<Map<string, any>> => {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id) && OBJECT_ID.test(String(id))))];
  if (!wanted.length) return new Map();
  const users = await User.find({ _id: { $in: wanted } }).select('_id username isBot botMetadata').lean();
  return new Map(users.map((user: any) => [String(user._id), user]));
};

/** A bot's human owner in this pod: its installation's installer, else its ownerUserId. */
const humanOwnerOfBot = async (bot: any, podId: string): Promise<string | null> => {
  const agentName = String(bot?.botMetadata?.agentName || '').toLowerCase();
  const instanceId = String(bot?.botMetadata?.instanceId || 'default');
  const candidates: string[] = [];
  if (agentName) {
    const installation = await AgentInstallation.findOne({
      podId, agentName, instanceId, status: { $ne: 'uninstalled' },
    }).select('installedBy').lean();
    if (installation?.installedBy) candidates.push(String(installation.installedBy));
  }
  if (bot?.botMetadata?.ownerUserId) candidates.push(String(bot.botMetadata.ownerUserId));
  const people = await usersById(candidates);
  return candidates.find((id) => isHuman(people.get(id))) || null;
};

interface Author {
  agentUserId: string;
  agentName: string;
  instanceId: string;
  displayName?: string;
  installationConfig?: Record<string, unknown> | null;
}

/** ADR-037 §4: both owner sources, each kept only when it names a person. */
const resolveOwners = async (author: Author, podId: string): Promise<{
  ownerInstalledBy: string | null; ownerUserId: string | null;
}> => {
  const [installation, agent] = await Promise.all([
    AgentInstallation.findOne({
      podId, agentName: author.agentName, instanceId: author.instanceId, status: 'active',
    }).select('installedBy').lean(),
    User.findById(author.agentUserId).select('isBot botMetadata').lean(),
  ]);
  const installedBy = installation?.installedBy ? String(installation.installedBy) : null;
  const ownerUserId = agent?.botMetadata?.ownerUserId ? String(agent.botMetadata.ownerUserId) : null;
  const people = await usersById([installedBy, ownerUserId]);
  // ADR-004 C1: installedBy can be the agent itself, which isn't a person.
  const owners = {
    ownerInstalledBy: installedBy && isHuman(people.get(installedBy)) ? installedBy : null,
    ownerUserId: ownerUserId && isHuman(people.get(ownerUserId)) ? ownerUserId : null,
  };
  if (!owners.ownerInstalledBy && !owners.ownerUserId) {
    fail("This agent's owner isn't a person Commonly can name, so it can't send a plan for review",
      422, 'owner_unresolved');
  }
  return owners;
};

/**
 * ADR-037 §3: the requester is derived, never chosen by the agent. A message
 * delivered to this agent as a wake, else the task's creator, else the owner.
 */
const resolveRequester = async (input: {
  author: Author; podId: string; sourceMessageId: string; task: any; owners: { ownerInstalledBy: string | null; ownerUserId: string | null };
}): Promise<{ requesterUserId: string; requesterAgentUserId?: string; provenance: 'message' | 'task' | 'owner' }> => {
  const { author, podId, sourceMessageId, task, owners } = input;
  const unresolved = (): never => fail(
    "Commonly couldn't find the person this work is for", 422, 'requester_unresolved',
  );
  const personOrOwner = async (userId: string) => {
    const user = (await usersById([userId])).get(userId);
    if (!user) return unresolved();
    if (!user.isBot) return { requesterUserId: userId };
    const owner = await humanOwnerOfBot(user, podId);
    if (!owner) return unresolved();
    return { requesterUserId: owner, requesterAgentUserId: userId };
  };

  if (sourceMessageId) {
    const event = await AgentEvent.findOne({
      agentName: author.agentName,
      instanceId: author.instanceId,
      podId,
      type: { $in: WAKE_TYPES },
      status: { $in: ['delivered', 'acked'] },
      deliveryMode: { $ne: 'digest' },
      $or: [{ 'payload.messageId': sourceMessageId }, { 'payload.coalesced.messageId': sourceMessageId }],
    }).select('payload').lean();
    if (!event) {
      return fail('That message was not delivered to this agent, so it cannot name who asked',
        400, 'source_not_delivered');
    }
    const payload = event.payload || {};
    const entry = String(payload.messageId) === sourceMessageId
      ? payload
      : (payload.coalesced || []).find((item: any) => String(item?.messageId) === sourceMessageId);
    const authorId = entry?.userId ? String(entry.userId) : '';
    if (!authorId) return unresolved();
    return { ...(await personOrOwner(authorId)), provenance: 'message' };
  }
  // A task the author agent made itself says nothing about who asked: that
  // falls through to the owner, and the card says so.
  if (task?.createdByUserId && String(task.createdByUserId) !== author.agentUserId) {
    return { ...(await personOrOwner(String(task.createdByUserId))), provenance: 'task' };
  }
  const owner = owners.ownerInstalledBy || owners.ownerUserId;
  if (!owner) return unresolved();
  return { requesterUserId: owner, provenance: 'owner' };
};

type ReviewerRefusal = 'not_a_person' | 'not_a_member' | 'is_requester' | 'is_owner';

/** ADR-037 §4: the reviewer rule, enforced here before anything is posted. */
const checkReviewer = async (input: {
  pod: any; reviewerUserId: string; requesterUserId: string; owners: { ownerInstalledBy: string | null; ownerUserId: string | null };
}): Promise<void> => {
  const { pod, reviewerUserId, requesterUserId, owners } = input;
  const memberIds = (pod.members || []).map((member: any) => String(member?._id || member));
  const people = await User.find({ _id: { $in: memberIds }, isBot: { $ne: true } }).select('_id').lean();
  const excluded = new Set([requesterUserId, owners.ownerInstalledBy, owners.ownerUserId].filter(Boolean).map(String));
  const eligible = people
    .map((person: any) => String(person._id))
    .filter((id: string) => isListedPodMember(pod, id) && !excluded.has(id));
  if (!eligible.length) {
    fail('Nobody in this pod can review it: invite a reviewer into the pod', 409, 'no_eligible_reviewer');
  }
  if (eligible.includes(reviewerUserId)) return;
  let reason: ReviewerRefusal;
  const reviewer = (await usersById([reviewerUserId])).get(reviewerUserId);
  if (!reviewer || reviewer.isBot) reason = 'not_a_person';
  else if (!isListedPodMember(pod, reviewerUserId)) reason = 'not_a_member';
  else if (reviewerUserId === requesterUserId) reason = 'is_requester';
  else reason = 'is_owner';
  fail('The reviewer must be a person in this pod other than who asked and the agent\'s owner',
    400, 'reviewer_ineligible', { reason });
};

const usernameOf = async (userId: string | null | undefined): Promise<string> => {
  if (!userId) return '';
  return String((await usersById([userId])).get(userId)?.username || '');
};

const provenanceLine = async (asked: HandBackRecord['asked'], taskId: string | null): Promise<string> => {
  const who = await usernameOf(asked.requesterUserId);
  const handle = who ? `@${who}` : 'a person';
  const viaAgent = asked.requesterAgentUserId ? ' (through their agent)' : '';
  if (asked.provenance === 'message') return `Requester: ${handle}${viaAgent}, from the message that asked.`;
  if (asked.provenance === 'task') return `Requester: ${handle}${viaAgent}, who created task ${taskId}.`;
  return `Requester: the agent's owner (${handle}), no source message.`;
};

const OPTIONS = [
  { label: 'Accept', description: 'Go ahead. Say why.' },
  { label: 'Refuse', description: 'Stop here. Say why.' },
];

/** Plan-send (ADR-037 §5): create the record, then its plan card. */
export const sendPlan = async (input: {
  author: Author;
  podId: string;
  body: Record<string, unknown>;
}): Promise<Record<string, unknown>> => {
  const { author, podId } = input;
  const body = plainObject(input.body || {}, 'body');
  closedKeys(body, ['reviewerUserId', 'asked', 'plan', 'threadRootId', 'next', 'supersedes'], 'plan');
  const reviewerUserId = text(body.reviewerUserId, 'reviewerUserId', 24);
  if (!OBJECT_ID.test(reviewerUserId)) fail('reviewerUserId must be a user id', 400, 'invalid_hand_back');
  const askedRaw = plainObject(body.asked, 'asked');
  closedKeys(askedRaw, ['text', 'sourceMessageId', 'taskId'], 'asked');
  const askedText = text(askedRaw.text, 'asked.text', CAPS.askedText);
  const sourceMessageId = text(askedRaw.sourceMessageId, 'asked.sourceMessageId', 64, { required: false });
  const taskId = text(askedRaw.taskId, 'asked.taskId', 128, { required: false });
  const planText = text(body.plan, 'plan', CAPS.plan);
  const threadRootId = text(body.threadRootId, 'threadRootId', 32, { required: false }) || null;
  const supersedes = text(body.supersedes, 'supersedes', 64, { required: false }) || null;
  let nextInput: { agentName: string; instanceId: string } | null = null;
  if (body.next !== undefined && body.next !== null) {
    const raw = plainObject(body.next, 'next');
    closedKeys(raw, ['agentName', 'instanceId'], 'next');
    nextInput = {
      agentName: text(raw.agentName, 'next.agentName', 120).toLowerCase(),
      instanceId: (text(raw.instanceId, 'next.instanceId', 120, { required: false }) || 'default').toLowerCase(),
    };
  }

  const pod = await Pod.findById(podId).select('_id type members').lean();
  if (!pod) fail('Pod not found', 404, 'pod_not_found');
  // ADR-037 §4: a DM pod holds two members, so it can never supply a reviewer.
  if (DM_POD_TYPES.has(String(pod.type))) {
    fail('Nobody in this pod can review it: invite a reviewer into the pod', 409, 'no_eligible_reviewer');
  }
  const owners = await resolveOwners(author, podId);
  let task: any = null;
  if (taskId) {
    task = await Task.findOne({ podId, taskId }).select('taskId createdByUserId').lean();
    if (!task) fail('No task with that id in this pod', 400, 'task_not_found');
  }
  const requester = await resolveRequester({ author, podId, sourceMessageId, task, owners });
  let next: HandBackRecord['next'] = null;
  if (nextInput) {
    const installed = await AgentInstallation.findOne({
      podId, agentName: nextInput.agentName, instanceId: nextInput.instanceId, status: 'active',
    }).select('_id').lean();
    if (!installed) fail('The next agent must be installed in this pod', 400, 'next_not_installed');
    const nextUser = await User.findOne({
      isBot: true, 'botMetadata.agentName': nextInput.agentName, 'botMetadata.instanceId': nextInput.instanceId,
    }).select('_id').lean();
    next = { agentUserId: nextUser?._id ? String(nextUser._id) : null, ...nextInput };
  }
  if (supersedes) {
    const prior = await repo.findById(supersedes);
    if (!prior || prior.podId !== podId || prior.authorAgentUserId !== author.agentUserId
      || !['plan_refused', 'refused', 'withdrawn'].includes(prior.status)) {
      fail('supersedes must name a refused or withdrawn record of yours in this pod', 400, 'invalid_supersedes');
    }
  }
  await checkReviewer({ pod, reviewerUserId, requesterUserId: requester.requesterUserId, owners });

  const asked: HandBackRecord['asked'] = {
    text: askedText,
    requesterUserId: requester.requesterUserId,
    ...(requester.requesterAgentUserId ? { requesterAgentUserId: requester.requesterAgentUserId } : {}),
    provenance: requester.provenance,
    ...(requester.provenance === 'message' ? { sourceMessageId } : {}),
  };
  const id = crypto.randomUUID();
  const now = new Date();
  // The record goes first, so a card never exists without one. If the card
  // can't be posted, the card-less record is removed again.
  await repo.insertPlan({
    id, podId, threadRootId, taskId: taskId || null, authorAgentUserId: author.agentUserId,
    agentName: author.agentName, instanceId: author.instanceId, ...owners, asked, reviewerUserId,
    plan: { text: planText }, next, supersedes, now,
  });
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { requestDecision } = require('./decisionRequestService');
  let card: Record<string, unknown>;
  try {
    card = await requestDecision({
      podId,
      agentUserId: author.agentUserId,
      agentName: author.agentName,
      instanceId: author.instanceId,
      displayName: author.displayName,
      installationConfig: author.installationConfig || null,
      decisionClass: 'implementation',
      title: bound(`Plan for review: ${askedText.split('\n')[0]}`, 160),
      question: bound(planText, 1000),
      context: bound([`Asked: ${askedText}`, await provenanceLine(asked, taskId || null)].join('\n\n'), 2000),
      options: OPTIONS,
      ...(threadRootId ? { threadRootId } : {}),
      deciderUserIds: [reviewerUserId],
      internal: {
        allowedValues: CARD_VALUES,
        deciderFallback: 'none',
        subject: { type: SUBJECT_TYPE, id, stage: 'plan' },
        metadata: { kind: 'hand-back', handBackId: id, stage: 'plan' },
      },
    });
  } catch (error) {
    await repo.deleteUnposted(id).catch((undoError: Error) => {
      console.warn('[hand-back] removing a plan whose card failed did not apply; recovery retries:', undoError.message);
    });
    throw error;
  }
  return postedCardResult(await attachPostedCard(id, 'plan', card), 'plan_sent', card);
};

const closeOrphanCard = async (decisionId: string, why: string): Promise<void> => {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    if (!(await require('./decisionRequestService').closeDecision(decisionId))) {
      console.warn(`[hand-back] a card posted after ${why} was not closed (already settled or under a ruling lock)`);
    }
  } catch (error) {
    console.warn(`[hand-back] closing a card posted after ${why} failed:`, (error as Error).message);
  }
};

/**
 * Store a just-posted card's id on its record. Recovery may have attached the
 * same card first (found by its subject), which counts as attached. If the
 * record is gone or has moved on, the card arrived too late: it is closed so
 * it doesn't sit pending with nothing behind it, and the agent hears
 * stale_state.
 */
const attachPostedCard = async (
  id: string, stage: 'plan' | 'result', card: Record<string, unknown>,
): Promise<HandBackRecord> => {
  const decisionId = String(card.decisionId);
  const attached = stage === 'plan'
    ? await repo.attachPlanDecision(id, decisionId, new Date())
    : await repo.attachHandbackDecision(id, decisionId, new Date());
  if (attached) return attached;
  const current: HandBackRecord | null = await repo.findById(id);
  const held = stage === 'plan' ? current?.planDecisionId : current?.handbackDecisionId;
  if (current && held === decisionId) return current;
  await closeOrphanCard(decisionId, 'its record moved on');
  return fail('The record changed while its card was posted', 409, 'stale_state');
};

/**
 * What the agent hears once its card is posted and attached. If the record
 * was withdrawn while the card was being posted, the card is closed now (the
 * sweep retries if that fails) and the agent is told the record was withdrawn,
 * with the card it posted: not stale_state, since a card did go up.
 */
const postedCardResult = async (
  record: HandBackRecord, expected: HandBackStatus, card: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const decisionId = String(card.decisionId);
  const messageId = String(card.messageId);
  if (record.status === 'withdrawn') {
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      await require('./decisionRequestService').closeDecision(decisionId);
    } catch (error) {
      console.warn('[hand-back] closing a card posted after a withdraw failed; the sweep retries:', (error as Error).message);
    }
    return {
      handBack: {
        id: record.id, status: 'withdrawn', decisionId, messageId, withdrawnBy: record.withdrawnBy,
        note: 'The record was withdrawn while its card was posted; the card has been closed.',
      },
    };
  }
  return { handBack: { id: record.id, status: expected, decisionId, messageId } };
};

const changedItem = (raw: Record<string, unknown>, index: number) => {
  closedKeys(raw, ['kind', 'ref', 'note'], `changed[${index}]`);
  const kind = text(raw.kind, `changed[${index}].kind`, 20);
  if (!(CHANGED_KINDS as readonly string[]).includes(kind)) {
    fail(`changed[${index}].kind must be one of ${CHANGED_KINDS.join(', ')}`, 400, 'invalid_hand_back');
  }
  const note = text(raw.note, `changed[${index}].note`, CAPS.itemText, { required: false });
  return { kind, ref: text(raw.ref, `changed[${index}].ref`, CAPS.itemText), ...(note ? { note } : {}) };
};
const checkedItem = (raw: Record<string, unknown>, index: number) => {
  closedKeys(raw, ['what', 'how'], `checked[${index}]`);
  return {
    what: text(raw.what, `checked[${index}].what`, CAPS.itemText),
    how: text(raw.how, `checked[${index}].how`, CAPS.itemText),
  };
};
const unverifiedItem = (raw: Record<string, unknown>, index: number) => {
  closedKeys(raw, ['what', 'why'], `unverified[${index}]`);
  const why = text(raw.why, `unverified[${index}].why`, CAPS.itemText, { required: false });
  return { what: text(raw.what, `unverified[${index}].what`, CAPS.itemText), ...(why ? { why } : {}) };
};

const resultSummary = (record: Pick<HandBackRecord, 'changed' | 'checked' | 'unverified'>): string => {
  const lines = ['Changed:'];
  (record.changed || []).forEach((item) => lines.push(`- ${item.kind}: ${item.ref}${item.note ? ` (${item.note})` : ''}`));
  lines.push('', 'Checked:');
  if (!(record.checked || []).length) lines.push('- nothing listed');
  (record.checked || []).forEach((item) => lines.push(`- ${item.what}: ${item.how}`));
  lines.push('', 'Not verified:');
  if (!(record.unverified || []).length) lines.push('- The agent listed nothing as unverified');
  (record.unverified || []).forEach((item) => lines.push(`- ${item.what}${item.why ? `: ${item.why}` : ''}`));
  return lines.join('\n');
};

const decisionsById = async (ids: Array<string | null>): Promise<Map<string, any>> => {
  const wanted = ids.filter((id): id is string => Boolean(id) && OBJECT_ID.test(String(id)));
  if (!wanted.length) return new Map();
  const rows = await DecisionRequest.find({ _id: { $in: wanted } }).lean();
  return new Map(rows.map((row: any) => [String(row._id), row]));
};

const rulingCopy = (decision: any): HandBackRuling | null => {
  const ruling = decision?.ruling;
  if (!ruling?.value || !(VERDICTS as readonly string[]).includes(String(ruling.value))) return null;
  return {
    verdict: ruling.value,
    reason: String(ruling.reason || ''),
    byUserId: String(ruling.byUserId),
    at: new Date(ruling.at || Date.now()).toISOString(),
  };
};

const enqueueReceived = async (record: HandBackRecord): Promise<void> => {
  if (!record.next) return;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const AgentEventService = require('./agentEventService');
  const ruling = record.handbackRuling;
  await AgentEventService.enqueue({
    agentName: record.next.agentName,
    instanceId: record.next.instanceId,
    podId: record.podId,
    type: 'handback.received',
    payload: {
      handBackId: record.id,
      podId: record.podId,
      from: { agentName: record.agentName, instanceId: record.instanceId, agentUserId: record.authorAgentUserId },
      ...(record.taskId ? { taskId: record.taskId } : {}),
      asked: record.asked,
      plan: record.plan,
      changed: record.changed || [],
      checked: record.checked || [],
      unverified: record.unverified || [],
      ...(ruling ? { acceptedBy: { userId: ruling.byUserId, reason: ruling.reason, at: ruling.at } } : {}),
      // A cue in the content, not only the fields (CLAUDE.md: models read the content).
      content: [
        `Hand-back accepted for you to continue (record ${record.id}).`,
        `Asked: ${record.asked?.text || ''}`,
        `Plan: ${record.plan?.text || ''}`,
        resultSummary(record),
        ruling?.reason ? `Accepted by the reviewer because: ${ruling.reason}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  });
};

/**
 * Tell the next agent, then stamp the record (WHERE received_enqueued_at IS
 * NULL). Only the ruling's CAS winner and the sweep call this; the sweep also
 * looks for an event already queued, so a crash between the two steps does
 * not queue a second one.
 */
const deliverReceived = async (record: HandBackRecord, opts: { checkQueued?: boolean } = {}): Promise<boolean> => {
  if (!record.next || record.receivedEnqueuedAt) return false;
  if (opts.checkQueued) {
    const queued = await AgentEvent.exists({ type: 'handback.received', 'payload.handBackId': record.id });
    if (queued) {
      await repo.markReceivedEnqueued(record.id, new Date());
      return false;
    }
  }
  await enqueueReceived(record);
  await repo.markReceivedEnqueued(record.id, new Date());
  return true;
};

/**
 * ADR-037 §3: copy a ruled card into its record by compare-and-set. Only the
 * writer that wins moves the record, and only it enqueues `handback.received`,
 * so the event fires once. Safe to call any number of times.
 */
export const applyRuling = async (decision: any): Promise<{ handBack: { id: string; status: HandBackStatus } } | null> => {
  const subject = decision?.subject;
  if (subject?.type !== SUBJECT_TYPE || decision?.status !== 'ruled') return null;
  const ruling = rulingCopy(decision);
  const decisionId = String(decision._id);
  let moved: HandBackRecord | null = null;
  if (ruling && subject.stage === 'plan') {
    moved = await repo.transition({
      id: String(subject.id), from: 'plan_sent', to: ruling.verdict === 'Accept' ? 'plan_accepted' : 'plan_refused',
      set: { plan_ruling: ruling, plan_ruled_at: new Date(ruling.at) },
      where: { plan_decision_id: decisionId }, now: new Date(),
    });
  } else if (ruling && subject.stage === 'result') {
    moved = await repo.transition({
      id: String(subject.id), from: 'handed_back', to: ruling.verdict === 'Accept' ? 'accepted' : 'refused',
      set: { handback_ruling: ruling, ruled_at: new Date(ruling.at) },
      where: { handback_decision_id: decisionId }, now: new Date(),
    });
    if (moved?.status === 'accepted') {
      try {
        await deliverReceived(moved);
      } catch (error) {
        console.warn('[hand-back] handback.received enqueue failed; the sweep retries:', (error as Error).message);
      }
    }
  }
  const current = moved || await repo.findById(String(subject.id));
  return current ? { handBack: { id: current.id, status: current.status } } : null;
};

/** The stage check chooseDecision runs for a `hand_back` card (ADR-037 §2). */
export const checkStage = async (decision: any): Promise<boolean> => {
  const subject = decision?.subject;
  if (subject?.type !== SUBJECT_TYPE) return false;
  const record = await repo.findById(String(subject.id));
  if (!record) return false;
  const decisionId = String(decision._id);
  if (subject.stage === 'plan') return record.status === 'plan_sent' && record.planDecisionId === decisionId;
  if (subject.stage === 'result') return record.status === 'handed_back' && record.handbackDecisionId === decisionId;
  return false;
};

let registered = false;
/** Boot-time registration (server.ts). Idempotent. */
export const registerHandBackSubject = (): void => {
  if (registered) return;
  registerDecisionSubject(SUBJECT_TYPE, { checkStage, onRuled: applyRuling });
  registered = true;
};

/** The newest live card a record posted for a stage, found by its subject. */
const cardBySubject = async (id: string, stage: 'plan' | 'result'): Promise<any> => DecisionRequest.findOne({
  'subject.type': SUBJECT_TYPE, 'subject.id': id, 'subject.stage': stage, status: { $in: ['pending', 'ruled'] },
}).sort({ createdAt: -1 }).lean();

/**
 * A record waiting on a card whose id it never stored: the card post or the
 * attach failed, and so did its undo. If the card exists (by its subject), it
 * is attached now and becomes rulable; no second card is posted. If no card
 * exists once the grace window has passed, the post failed: the plan record is
 * removed, or the hand-back goes back to plan_accepted so the agent can retry.
 * Both undos are the same conditional writes the poster uses, so neither can
 * undo a concurrent withdraw or a card attached meanwhile. Null when the
 * record is gone.
 */
const recoverUnattached = async (record: HandBackRecord, now: Date): Promise<HandBackRecord | null> => {
  const stage = record.status === 'plan_sent' ? 'plan' : 'result';
  const card = await cardBySubject(record.id, stage);
  if (card) {
    const attached = stage === 'plan'
      ? await repo.attachPlanDecision(record.id, String(card._id), new Date())
      : await repo.attachHandbackDecision(record.id, String(card._id), new Date());
    return attached || repo.findById(record.id);
  }
  const waitingSince = stage === 'plan' ? record.createdAt : (record.handedBackAt || record.updatedAt);
  if (now.getTime() - new Date(waitingSince).getTime() < CARD_POST_GRACE_MS) return record;
  if (stage === 'plan') {
    await repo.deleteUnposted(record.id);
  } else {
    await repo.transition({
      id: record.id, from: 'handed_back', to: 'plan_accepted',
      set: { changed: null, checked: null, unverified: null, handed_back_at: null },
      where: { handback_decision_id: null }, now: new Date(),
    });
  }
  return repo.findById(record.id);
};

/**
 * Reconcile (ADR-037 §3), on every read and in the sweep: a record still
 * waiting on a card that is already ruled catches up now, and a record that
 * never stored its card's id is recovered (recoverUnattached). Returns the
 * current record, or null when recovery removed it.
 */
export const reconcile = async (
  record: HandBackRecord, cards?: Map<string, any>, now: Date = new Date(),
): Promise<HandBackRecord | null> => {
  let current = record;
  if ((current.status === 'plan_sent' && !current.planDecisionId)
    || (current.status === 'handed_back' && !current.handbackDecisionId)) {
    try {
      const recovered = await recoverUnattached(current, now);
      if (!recovered) return null;
      current = recovered;
    } catch (error) {
      console.warn('[hand-back] recovering a record without its card failed:', (error as Error).message);
      return current;
    }
  }
  let cardId: string | null = null;
  if (current.status === 'plan_sent') cardId = current.planDecisionId;
  else if (current.status === 'handed_back') cardId = current.handbackDecisionId;
  if (!cardId) return current;
  const card = cards?.has(cardId) ? cards.get(cardId) : (await decisionsById([cardId])).get(cardId);
  if (card?.status !== 'ruled') return current;
  try {
    await applyRuling(card);
  } catch (error) {
    console.warn('[hand-back] read-path reconcile failed:', (error as Error).message);
    return current;
  }
  return (await repo.findById(current.id)) || current;
};

const reconcileMany = async (records: HandBackRecord[]): Promise<HandBackRecord[]> => {
  const cards = await decisionsById(records.flatMap((record) => [record.planDecisionId, record.handbackDecisionId]));
  const current = await Promise.all(records.map((record) => reconcile(record, cards)));
  return current.filter((record): record is HandBackRecord => Boolean(record));
};

/** Hand-back (ADR-037 §5). Only the author, and only from plan_accepted. */
export const handBack = async (input: {
  author: Author; authorizedPod: (podId: string) => boolean; id: string; body: Record<string, unknown>;
}): Promise<Record<string, unknown>> => {
  const body = plainObject(input.body || {}, 'body');
  closedKeys(body, ['changed', 'checked', 'unverified'], 'hand-back');
  const changed = list(body.changed, 'changed', { min: 1 }, changedItem);
  if (body.checked === undefined) fail('checked is required (it may be empty)', 400, 'invalid_hand_back');
  const checked = list(body.checked, 'checked', {}, checkedItem);
  if (body.unverified === undefined) fail('unverified is required (it may be empty)', 400, 'invalid_hand_back');
  const unverified = list(body.unverified, 'unverified', {}, unverifiedItem);

  const found = await repo.findById(input.id);
  if (!found || !input.authorizedPod(found.podId)) return fail('Hand-back not found', 404, 'hand_back_not_found');
  if (found.authorAgentUserId !== input.author.agentUserId) {
    fail('Only the agent that sent the plan can hand back', 403, 'not_author');
  }
  const record = await reconcile(found);
  if (!record) return fail('Hand-back not found', 404, 'hand_back_not_found');
  if (record.status !== 'plan_accepted') {
    fail(`This record is ${record.status}; a hand-back needs an accepted plan`, 409, 'stale_state', { status: record.status });
  }
  const now = new Date();
  // Write-once: the result fields are set by the one transition out of
  // plan_accepted. A second hand-back loses this compare-and-set.
  const moved = await repo.transition({
    id: record.id, from: 'plan_accepted', to: 'handed_back', set: { changed, checked, unverified, handed_back_at: now }, now,
  });
  if (!moved) fail('Someone else changed this record first', 409, 'stale_state');
  const rec = moved as HandBackRecord;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { requestDecision } = require('./decisionRequestService');
  let card: Record<string, unknown>;
  try {
    card = await requestDecision({
      podId: rec.podId,
      agentUserId: input.author.agentUserId,
      agentName: input.author.agentName,
      instanceId: input.author.instanceId,
      displayName: input.author.displayName,
      installationConfig: input.author.installationConfig || null,
      decisionClass: 'implementation',
      title: bound(`Hand-back for review: ${rec.asked.text.split('\n')[0]}`, 160),
      question: bound(resultSummary(rec), 1000),
      context: bound([`Asked: ${rec.asked.text}`, `Plan: ${rec.plan.text}`].join('\n\n'), 2000),
      options: OPTIONS,
      ...(rec.threadRootId || rec.planDecisionId ? {
        threadRootId: rec.threadRootId || (await decisionsById([rec.planDecisionId])).get(String(rec.planDecisionId))?.messageId,
      } : {}),
      deciderUserIds: [rec.reviewerUserId],
      internal: {
        allowedValues: CARD_VALUES,
        deciderFallback: 'none',
        subject: { type: SUBJECT_TYPE, id: rec.id, stage: 'result' },
        metadata: { kind: 'hand-back', handBackId: rec.id, stage: 'result' },
      },
    });
  } catch (error) {
    // No card was posted: put the record back so the agent can retry. If this
    // undo fails too, recovery does it once the grace window has passed.
    await repo.transition({
      id: rec.id, from: 'handed_back', to: 'plan_accepted',
      set: { changed: null, checked: null, unverified: null, handed_back_at: null },
      where: { handback_decision_id: null }, now: new Date(),
    }).catch((undoError: Error) => {
      console.warn('[hand-back] undoing a hand-back whose card failed did not apply; recovery retries:', undoError.message);
      return null;
    });
    throw error;
  }
  return postedCardResult(await attachPostedCard(rec.id, 'result', card), 'handed_back', card);
};

/**
 * CAP read: an agent whose token covers the record's pod and who can view
 * that pod (DMService.canViewPod). Both checks run before reconcile, so a
 * refused caller causes no write.
 */
export const getForAgent = async (
  id: string, authorizedPod: (podId: string) => boolean, viewerUserId: string,
): Promise<HandBackRecord> => {
  const record = await repo.findById(id);
  if (!record || !authorizedPod(record.podId)) return fail('Hand-back not found', 404, 'hand_back_not_found');
  const pod = await Pod.findById(record.podId).select('_id type members').lean();
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const DMService = require('./dmService');
  if (!pod || !(await DMService.canViewPod(viewerUserId, pod))) {
    return fail('Hand-back not found', 404, 'hand_back_not_found');
  }
  return (await reconcile(record)) || fail('Hand-back not found', 404, 'hand_back_not_found');
};

/** Shell read: a pod member (DMService.canViewPod) lists the pod's records. */
export const listForPod = async (podId: string, viewerUserId: string, ids?: string[]): Promise<{
  handBacks: HandBackRecord[]; people: Record<string, string>;
}> => {
  const pod = await Pod.findById(podId).select('_id type members').lean();
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const DMService = require('./dmService');
  if (!pod || !(await DMService.canViewPod(viewerUserId, pod))) {
    return fail('Pod not found', 404, 'pod_not_found');
  }
  const records = await reconcileMany(ids?.length ? await repo.findByIds(podId, ids) : await repo.listForPod(podId));
  const users = await usersById(records.flatMap((record) => [
    record.asked?.requesterUserId, record.reviewerUserId, record.ownerInstalledBy, record.ownerUserId,
    record.planRuling?.byUserId, record.handbackRuling?.byUserId,
  ]));
  const people: Record<string, string> = {};
  users.forEach((user, userId) => { people[userId] = String(user.username || ''); });
  return { handBacks: records, people };
};

/**
 * Withdraw (ADR-037 §3): the author agent, or a person who owns it.
 *
 * A record with an open card takes that card's ruling lock first, the same
 * claim chooseDecision takes, so a withdraw and a ruling never both act. A
 * ruling already holding the lock wins: the withdraw answers
 * ruling_in_progress and can be retried. Holding the lock, the record moves to
 * withdrawn and the card closes on the lock's token; a ruling that arrives
 * meanwhile hears "being ruled", and on retry decision_closed. If the record
 * can't move, the lock is released and the card stays rulable. If the close
 * fails, the lock expires and the sweep re-closes the card.
 */
export const withdraw = async (input: {
  id: string;
  caller: { kind: 'agent'; agentUserId: string; authorizedPod: (podId: string) => boolean } | { kind: 'human'; userId: string };
  reason?: unknown;
}): Promise<Record<string, unknown>> => {
  const reason = text(input.reason, 'reason', CAPS.itemText, { required: false });
  const found = await repo.findById(input.id);
  const { caller } = input;
  const visible = found && (caller.kind === 'human' || caller.authorizedPod(found.podId));
  if (!found || !visible) return fail('Hand-back not found', 404, 'hand_back_not_found');
  const allowed = caller.kind === 'agent'
    ? caller.agentUserId === found.authorAgentUserId
    : [found.ownerInstalledBy, found.ownerUserId].includes(caller.userId);
  if (!allowed) {
    if (caller.kind === 'human') {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const DMService = require('./dmService');
      const pod = await Pod.findById(found.podId).select('_id type members').lean();
      if (!pod || !(await DMService.canViewPod(caller.userId, pod))) fail('Hand-back not found', 404, 'hand_back_not_found');
    }
    fail('Only the agent that sent it, or its owner, can withdraw it', 403, 'not_allowed');
  }
  const record = await reconcile(found as HandBackRecord);
  if (!record) return fail('Hand-back not found', 404, 'hand_back_not_found');
  const from = record.status;
  const stale = (status: HandBackStatus): never => fail(
    `This record is ${status} and can't be withdrawn`, 409, 'stale_state', { status },
  );
  if (!(repo.OPEN_STATUSES as string[]).includes(from)) stale(from);

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const decisions = require('./decisionRequestService');
  let openCard: string | null = null;
  if (from === 'plan_sent') openCard = record.planDecisionId;
  else if (from === 'handed_back') openCard = record.handbackDecisionId;
  let lockToken: string | null = null;
  if (openCard) {
    const claim = await decisions.claimRulingLock(openCard);
    if (claim.token) {
      lockToken = claim.token;
    } else if (claim.state === 'ruled') {
      // Ruled since the reconcile above: copy it in and report where it stands.
      const after = await reconcile(record);
      stale(after?.status || from);
    } else if (claim.state === 'locked') {
      fail('A reviewer is answering this right now; try again in a moment', 409, 'ruling_in_progress');
    }
    // closed or missing: there is no card left to close.
  }
  const release = async () => {
    if (!openCard || !lockToken) return;
    await decisions.releaseRulingLock(openCard, lockToken).catch((error: Error) => {
      console.warn('[hand-back] releasing the ruling lock after a failed withdraw failed; it expires:', error.message);
    });
  };

  const now = new Date();
  const withdrawnBy = caller.kind === 'agent'
    ? { kind: 'agent', userId: caller.agentUserId, ...(reason ? { reason } : {}) }
    : { kind: 'owner', userId: caller.userId, ...(reason ? { reason } : {}) };
  let moved: HandBackRecord | null;
  try {
    moved = await repo.transition({
      id: record.id, from, to: 'withdrawn', set: { withdrawn_by: withdrawnBy, withdrawn_at: now }, now,
    });
  } catch (error) {
    await release();
    throw error;
  }
  if (!moved) {
    await release();
    fail('Someone else changed this record first', 409, 'stale_state');
  }
  if (openCard && lockToken) {
    try {
      await decisions.closeDecision(openCard, { lockToken });
    } catch (error) {
      console.warn('[hand-back] closing the withdrawn card failed; the sweep retries:', (error as Error).message);
    }
  }
  return { handBack: { id: record.id, status: 'withdrawn' } };
};

/**
 * The scheduler sweep (ADR-037 §3): catch up records whose card is ruled,
 * recover records that never stored their card's id, and close a
 * still-pending card whose record was withdrawn.
 */
export const sweepHandBacks = async (now: Date = new Date()): Promise<{
  applied: number; closed: number; delivered: number;
}> => {
  if (!repo.isAvailable()) return { applied: 0, closed: 0, delivered: 0 };
  const records: HandBackRecord[] = await repo.listForReconcile(new Date(now.getTime() - WITHDRAWN_RECHECK_MS));
  const cards = await decisionsById(records.flatMap((record) => [record.planDecisionId, record.handbackDecisionId]));
  let applied = 0;
  let closed = 0;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { closeDecision } = require('./decisionRequestService');
  for (const record of records) {
    try {
      if (record.status === 'withdrawn') {
        for (const cardId of [record.planDecisionId, record.handbackDecisionId]) {
          if (cardId && cards.get(cardId)?.status === 'pending' && await closeDecision(cardId)) closed += 1;
        }
      } else {
        const after = await reconcile(record, cards, now);
        if (after?.status !== record.status || after?.planDecisionId !== record.planDecisionId
          || after?.handbackDecisionId !== record.handbackDecisionId) applied += 1;
      }
    } catch (error) {
      console.warn('[hand-back] sweep step failed:', (error as Error).message);
    }
  }
  let delivered = 0;
  const unannounced: HandBackRecord[] = await repo.listReceivedPending(new Date(now.getTime() - RECEIVED_GRACE_MS));
  for (const record of unannounced) {
    try {
      if (await deliverReceived(record, { checkQueued: true })) delivered += 1;
    } catch (error) {
      console.warn('[hand-back] handback.received retry failed:', (error as Error).message);
    }
  }
  return { applied, closed, delivered };
};

export default {
  sendPlan, handBack, getForAgent, listForPod, withdraw, applyRuling, checkStage, reconcile, sweepHandBacks,
  registerHandBackSubject, HandBackError, SUBJECT_TYPE, CAPS,
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  sendPlan, handBack, getForAgent, listForPod, withdraw, applyRuling, checkStage, reconcile, sweepHandBacks,
  registerHandBackSubject, HandBackError, SUBJECT_TYPE, CAPS,
};
