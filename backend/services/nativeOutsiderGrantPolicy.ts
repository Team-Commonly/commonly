/**
 * The native runtime's pod-scoped tool boundary for outsider-writable grants.
 * A grant targeted at any current member can put third-party text into this
 * pod, even when the native agent itself is outside the grant's audience.
 */
import Integration from '../models/Integration';
import Pod from '../models/Pod';
import RoomGrant from '../models/RoomGrant';
import { GRANT_BROKER_ID } from './installable/toolInstallables';

interface CandidateGrant {
  connectionId?: unknown;
  target?: { kind?: unknown; id?: unknown };
  audience?: unknown[];
}

const objectId = (value: unknown): string | null => {
  const id = String(value || '');
  return /^[a-f\d]{24}$/i.test(id) ? id.toLowerCase() : null;
};

export const podHasOutsiderWritableGrant = async (podId: string): Promise<boolean> =>
  (await podsWithOutsiderWritableGrants([podId])).has(objectId(podId) || '');

/** Read all of an identity's installation pods in one pass, without a cache. */
export const podsWithOutsiderWritableGrants = async (podIds: string[]): Promise<Set<string>> => {
  const ids = [...new Set(podIds.map(objectId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Set();
  const pods = await Pod.find({ _id: { $in: ids } }).select('_id members').lean() as
    Array<{ _id: unknown; members?: unknown[] }>;
  const memberSets = new Map(pods.map((pod) => [String(pod._id), new Set((pod.members || []).map(String))]));
  const allMembers = [...new Set([...memberSets.values()].flatMap((members) => [...members]))];
  if (!allMembers.length) return new Set();

  const grants = await RoomGrant.find({
    brokerId: GRANT_BROKER_ID,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    $or: [
      { 'target.kind': 'pod', 'target.id': { $in: ids } },
      { 'target.kind': 'seat', 'target.id': { $in: allMembers } },
    ],
  }).select('connectionId target audience').lean() as CandidateGrant[];

  const candidates = grants.flatMap((grant) => {
    const targetId = String(grant.target?.id || '');
    const audience = new Set((grant.audience || []).map(String));
    if (grant.target?.kind === 'pod') {
      const members = memberSets.get(targetId);
      return members && [...members].some((member) => audience.has(member))
        ? [{ podId: targetId, connectionId: String(grant.connectionId || '').trim() }] : [];
    }
    if (grant.target?.kind !== 'seat' || !audience.has(targetId)) return [];
    return [...memberSets].filter(([, members]) => members.has(targetId))
      .map(([podId]) => ({ podId, connectionId: String(grant.connectionId || '').trim() }));
  }).filter((candidate) => candidate.connectionId);
  const connectionIds = [...new Set(candidates.map((candidate) => candidate.connectionId))];
  if (!connectionIds.length) return new Set();
  const mongoIds = connectionIds.filter((value) => objectId(value));

  // Every current hosted-MCP entry and the GitHub App return text that an
  // outsider can write (§12). A still-active grant keeps the boundary even
  // when the connection is disconnected; revocation/expiry is what lifts it.
  const connections = await Integration.find({
    type: { $in: ['hosted-mcp', 'github-app'] },
    $or: [
      // Hosted-MCP connections name the Connection row's Mongo id.
      ...(mongoIds.length ? [{ _id: { $in: mongoIds } }] : []),
      // Existing GitHub App grants may name the app installation id instead.
      { type: 'github-app', installationId: { $in: connectionIds } },
    ],
  }).select('_id type installationId').lean() as Array<{ _id: unknown; type: string; installationId?: unknown }>;
  const matched = new Set(connections.flatMap((connection) =>
    [String(connection._id), ...(connection.type === 'github-app' ? [String(connection.installationId || '')] : [])]));
  return new Set(candidates.filter((candidate) => matched.has(candidate.connectionId))
    .map((candidate) => candidate.podId));
};
