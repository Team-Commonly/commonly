/**
 * messageActorService: who an agent's message is accountable to (F655).
 *
 * Two people, in the vocabulary of the grant record (ADR-033, `actor.owner`
 * and `actor.onBehalfOf`):
 *   - the owner, whose agent it is (agentOwnerService: this pod's installer,
 *     else the identity's ownerUserId, people only);
 *   - the person it acts on behalf of, derived from the run's trigger only:
 *     the message a native run claimed and is answering (`answeringMessageId`,
 *     set by the runtime from its own wake, never by the model or a request),
 *     when a person wrote it in this pod.
 * A reply edge never names anyone: the agent chooses what it replies to, so
 * replying to someone's old message must not make it act for them. A run no
 * person started (a heartbeat, a schedule, another agent) records no one, and
 * the owner is never filled in as that person: the owner can be the person
 * who asked, and then both name them. An external runtime (CAP, MCP, webhook,
 * BYO) carries no server-known trigger on its post, so it records the owner
 * only; deriving its asker from the event that woke it is a later step.
 *
 * A kernel line speaks for Commonly, so it records nothing. The two lookups
 * fail independently and never throw: a failure records nothing for that
 * half, and the post goes out as before.
 */
import { resolveAgentOwners, displayOwnerId } from './agentOwnerService';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');

export interface ResolvedMessageActor {
  ownerUserId?: string;
  onBehalfOfUserId?: string;
}

type AgentLike = {
  _id?: unknown;
  username?: string;
  isBot?: boolean;
  botMetadata?: { agentName?: string; instanceId?: string; ownerUserId?: unknown } | null;
} | null | undefined;

const ownerOf = async (input: {
  podId: string; agentUser: AgentLike; agentName?: string; instanceId?: string;
}): Promise<string | null> => {
  try {
    return displayOwnerId(await resolveAgentOwners(input));
  } catch (error) {
    console.warn('[message-actor] owner lookup failed; recording none:', (error as Error).message);
    return null;
  }
};

// The person who wrote the message this run claimed, when a person did, in this pod.
const personWhoAsked = async (podId: string, agentId: string, messageId: unknown): Promise<string | null> => {
  try {
    if (messageId == null || messageId === '') return null;
    // A legacy Mongo id the reconciler moved answers to its PG row.
    const pgId = await PGMessage.resolveId(String(messageId)) as string | null;
    if (!pgId) return null;
    const source = await PGMessage.findAuthor(pgId) as { userId: string; podId: string } | null;
    if (!source || source.podId !== podId || source.userId === agentId) return null;
    const author = await User.findById(source.userId).select('_id isBot').lean() as { isBot?: boolean } | null;
    return author && !author.isBot ? source.userId : null;
  } catch (error) {
    console.warn('[message-actor] asker lookup failed; recording none:', (error as Error).message);
    return null;
  }
};

export const resolveMessageActor = async (input: {
  podId: unknown;
  agentUser: AgentLike;
  /** The installation key the post declares, read before the identity's own. */
  agentName?: string;
  instanceId?: string;
  /** The message a native run claimed and is answering. Server-set only. */
  answeringMessageId?: unknown;
  /** Accepted and ignored: a reply edge never names the person acted for. */
  replyToMessageId?: unknown;
  authorKind?: 'kernel' | null;
}): Promise<ResolvedMessageActor | null> => {
  if (input.authorKind === 'kernel') return null;
  const podId = String(input.podId || '');
  const agentId = String(input.agentUser?._id || '');
  const [owner, asker] = await Promise.all([
    ownerOf({ podId, agentUser: input.agentUser, agentName: input.agentName, instanceId: input.instanceId }),
    personWhoAsked(podId, agentId, input.answeringMessageId),
  ]);
  const actor: ResolvedMessageActor = {
    ...(owner ? { ownerUserId: owner } : {}),
    ...(asker ? { onBehalfOfUserId: asker } : {}),
  };
  return Object.keys(actor).length ? actor : null;
};

/**
 * A bot row that posts through a person's message route with a user token
 * (auth sets `req.botCaller`) is an agent posting. It records its owner; that
 * route carries no server-known trigger, so it names no one it acted for.
 */
export const actorForBotCaller = async (
  podId: unknown,
  userId: unknown,
  botCaller: { username?: string; botMetadata?: Record<string, unknown> } | null | undefined,
): Promise<ResolvedMessageActor | null> => {
  if (!botCaller || !userId) return null;
  const botMetadata = (botCaller.botMetadata || {}) as NonNullable<NonNullable<AgentLike>['botMetadata']>;
  return resolveMessageActor({
    podId,
    agentUser: { _id: String(userId), username: botCaller.username, isBot: true, botMetadata },
  });
};

export default { resolveMessageActor, actorForBotCaller };

// CJS compat: let require() return the default export directly
module.exports = exports.default; Object.assign(module.exports, exports);
