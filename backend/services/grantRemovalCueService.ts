/**
 * F181: tell an agent, on its next mention, that a connector it held was taken
 * away by a person, so it does not tell them to "reconnect" something that was
 * deliberately removed.
 *
 * A revoked grant simply drops out of the next projection
 * (`selectLiveGrantsForIdentities`), so a seat reloads without the tool and
 * nothing tells it why. Its model then guesses at a fault on its own side. The
 * fix is a kernel cue, delivered the way CLAUDE.md's rule for mid-turn
 * affordances asks: one line inline in `payload.content`, not metadata.
 *
 * The pending note lives on the grant row (`RoomGrant.removalCuePending`), one
 * entry per agent, because ADR-034 D4 adds no Mongo collection:
 *  - `noteRevokedGrants` runs after `revokeGrant` moves a lineage (a direct
 *    revoke, or a whole connection being removed). Every agent in each moved
 *    grant's effective audience gets an entry.
 *  - `noteAgentRemovedFromGrant` runs when a granter takes one named agent off
 *    a grant; only that agent gets an entry.
 *  - `prependGrantRemovalCue` runs as a mention event is enqueued. It claims
 *    each entry with a filtered `$pull`, so an entry reaches exactly one
 *    event, and drops one whose agent holds a live grant on the same connector
 *    again (a re-grant before the next mention means nothing was lost).
 *
 * The line carries the connector's display name only. The repository, account
 * and grant stay out of it, and an entry is only ever read for its own agent.
 */
import { Types } from 'mongoose';
import RoomGrant from '../models/RoomGrant';
import type { IRoomGrantRemovalCue } from '../models/RoomGrant';
import Pod from '../models/Pod';
import User from '../models/User';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../integrations/hostedMcp/entries';
import { GRANT_BROKER_ID } from './installable/grantBrokerId';
import { seatEnvironmentKey } from './seatEnvironmentProjection';

export type GrantConnector = { id: string; label: string };

/**
 * The connector a grant belongs to, read from its tool names (TASK-753). Every
 * name carries its entry's namespace (`hostedMcpToolName`), so the namespace
 * still names the connector after its entry is hidden or its connection is
 * gone. A grant naming two namespaces, or one no entry claims, is not guessed at.
 */
const GITHUB_CONNECTOR: GrantConnector = { id: 'github', label: 'GitHub' };
export const grantConnector = (tools: string[] | undefined): GrantConnector | null => {
  const namespaces = new Set((tools || []).map((name) => (name.includes('.') ? name.slice(0, name.indexOf('.')) : '')));
  if (namespaces.size !== 1) return null;
  const [id] = [...namespaces];
  if (id === GITHUB_CONNECTOR.id) return GITHUB_CONNECTOR;
  const entry = id ? findHostedMcpEntry(HOSTED_MCP_ENTRIES, id) : undefined;
  return entry ? { id: entry.id, label: entry.title } : null;
};

/** A note older than this is dropped unread rather than delivered stale. */
export const GRANT_REMOVAL_CUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type RemovedGrant = {
  grantId: string;
  brokerId?: string;
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
  tools?: string[];
  audience?: unknown[];
  target?: { kind?: string; id?: unknown };
  ownerId?: string | null;
};

/**
 * Entries for the ids that are agents with an addressable identity: only an
 * agent receives mention events, so a human in the audience gets none.
 */
const entriesFor = async (agentIds: string[], byOwner: boolean): Promise<IRoomGrantRemovalCue[]> => {
  const ids = Array.from(new Set(agentIds.map(String))).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return [];
  const agents = await User.find({ _id: { $in: ids }, isBot: true })
    .select('_id botMetadata.agentName botMetadata.instanceId').lean() as Array<{
      _id: unknown; botMetadata?: { agentName?: string; instanceId?: string };
    }>;
  const at = new Date();
  return agents
    .filter((agent) => Boolean(String(agent.botMetadata?.agentName || '').trim()))
    .map((agent) => ({
      userId: String(agent._id),
      seat: seatEnvironmentKey(agent.botMetadata?.agentName, agent.botMetadata?.instanceId),
      byOwner,
      at,
    }));
};

/**
 * Replaces any earlier entry for the same agent, so a second removal refreshes
 * it, and clears entries too old to be shown, so an unread note cannot linger.
 */
const writeEntries = async (grantId: string, entries: IRoomGrantRemovalCue[]): Promise<number> => {
  if (!entries.length) return 0;
  const userIds = entries.map((entry) => entry.userId);
  const staleBefore = new Date(Date.now() - GRANT_REMOVAL_CUE_MAX_AGE_MS);
  await RoomGrant.updateOne({ grantId }, {
    $pull: { removalCuePending: { $or: [{ userId: { $in: userIds } }, { at: { $lt: staleBefore } }] } },
  });
  await RoomGrant.updateOne({ grantId }, { $push: { removalCuePending: { $each: entries } } });
  return entries.length;
};

/**
 * After `revokeGrant` moved these grants: note the loss for every agent that
 * could use one of them. A pod grant's audience is a mint-time snapshot, so it
 * is narrowed to the pod's current members, which is who held it. A grant that
 * had already expired was lost at its expiry, not by this revoke, and gets no
 * note.
 */
export const noteRevokedGrants = async (grantIds: string[], revokedBy: string): Promise<number> => {
  if (!grantIds.length) return 0;
  const grants = await RoomGrant.find({
    grantId: { $in: grantIds }, brokerId: GRANT_BROKER_ID, expiresAt: { $gt: new Date() },
  }).select('grantId tools audience target ownerId').lean() as RemovedGrant[];
  let written = 0;
  for (const grant of grants) {
    if (!grantConnector(grant.tools)) continue;
    let holders = (grant.audience || []).map(String);
    if (grant.target?.kind === 'pod') {
      // eslint-disable-next-line no-await-in-loop
      const pod = await Pod.findById(String(grant.target.id))
        .select('members').lean() as { members?: unknown[] } | null;
      const members = new Set((pod?.members || []).map(String));
      holders = holders.filter((id) => members.has(id));
    }
    const byOwner = Boolean(grant.ownerId) && String(grant.ownerId) === String(revokedBy);
    // eslint-disable-next-line no-await-in-loop
    written += await writeEntries(grant.grantId, await entriesFor(holders, byOwner));
  }
  return written;
};

/**
 * The granter took one named agent off a grant (F94). Only that agent is told,
 * and only when the grant was still live on the broker: a revoked or expired
 * grant was already lost, and `noteRevokedGrants` applies the same test.
 */
export const noteAgentRemovedFromGrant = async (grant: RemovedGrant, agentId: string): Promise<number> => {
  if (grant.brokerId !== GRANT_BROKER_ID || grant.revokedAt) return 0;
  if (!grant.expiresAt || new Date(grant.expiresAt).getTime() <= Date.now()) return 0;
  if (!grantConnector(grant.tools)) return 0;
  return writeEntries(grant.grantId, await entriesFor([agentId], true));
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the agent holds a live broker grant on this connector again. */
const stillHoldsConnector = async (agentUserId: string, connectorId: string): Promise<boolean> => Boolean(
  await RoomGrant.exists({
    brokerId: GRANT_BROKER_ID,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    audience: agentUserId,
    tools: { $regex: `^${escapeRegex(connectorId)}\\.` },
  }),
);

export const grantRemovalCueLine = (connectorLabel: string, byOwner: boolean): string => (byOwner
  ? `[access: ${connectorLabel} access was removed by its owner. `
    + 'There is nothing to reconnect; ask them if you need it again.]'
  : `[access: ${connectorLabel} access was removed. `
    + 'There is nothing to reconnect; ask the person who granted it if you need it again.]');

type PendingGrant = { _id: unknown; tools?: string[]; removalCuePending?: IRoomGrantRemovalCue[] };

/**
 * Claims every pending entry for this agent and returns the lines to show, one
 * per connector. Each entry is claimed by a `$pull` filtered on the entry still
 * being there, and only the build whose filter matched shows it, so
 * concurrent callers never repeat one.
 */
export const consumeGrantRemovalCues = async (agentName: string, instanceId: string): Promise<string[]> => {
  if (!String(agentName || '').trim()) return [];
  const seat = seatEnvironmentKey(agentName, instanceId);
  const grants = await RoomGrant.find({ 'removalCuePending.seat': seat })
    .select('_id tools removalCuePending').lean() as PendingGrant[];
  const lines = new Map<string, string>();
  for (const grant of grants) {
    const connector = grantConnector(grant.tools);
    // Only this agent's entries: a grant two agents held carries one for each.
    for (const entry of (grant.removalCuePending || []).filter((pending) => pending.seat === seat)) {
      // The filter names the entry, so a build that finds it already pulled by
      // a concurrent one matches no row. The filter is the claim: RoomGrant has
      // timestamps, so an unfiltered update always reports a modification.
      // eslint-disable-next-line no-await-in-loop
      const claimed = await RoomGrant.updateOne(
        { _id: grant._id, 'removalCuePending.userId': entry.userId },
        { $pull: { removalCuePending: { userId: entry.userId } } },
      );
      if (!claimed.modifiedCount || !connector || lines.has(connector.id)) continue;
      if (Date.now() - new Date(entry.at).getTime() > GRANT_REMOVAL_CUE_MAX_AGE_MS) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await stillHoldsConnector(entry.userId, connector.id)) continue;
      lines.set(connector.id, grantRemovalCueLine(connector.label, entry.byOwner));
    }
  }
  return [...lines.values()];
};

/**
 * Prepends the pending lines to a mention payload's `content`. A payload with
 * no string content is returned untouched and its entries stay pending for the
 * next event that has one.
 */
export const prependGrantRemovalCue = async (
  agentName: string,
  instanceId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const content = payload?.content;
  if (typeof content !== 'string' || content.length === 0) return payload;
  const lines = await consumeGrantRemovalCues(agentName, instanceId);
  if (!lines.length) return payload;
  return { ...payload, content: `${lines.join('\n')}\n\n${content}` };
};

export default {
  grantConnector,
  noteRevokedGrants,
  noteAgentRemovedFromGrant,
  consumeGrantRemovalCues,
  prependGrantRemovalCue,
  grantRemovalCueLine,
};

// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default;
Object.assign(module.exports, exports);
