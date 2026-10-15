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
  return /^[a-f\d]{24}$/i.test(id) ? id : null;
};

export const podHasOutsiderWritableGrant = async (podId: string): Promise<boolean> => {
  const id = objectId(podId);
  if (!id) return false;
  const pod = await Pod.findById(id).select('members').lean() as { members?: unknown[] } | null;
  if (!pod) return false;
  const members = new Set((pod.members || []).map(String));
  if (!members.size) return false;

  const grants = await RoomGrant.find({
    brokerId: GRANT_BROKER_ID,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    $or: [
      { 'target.kind': 'pod', 'target.id': id },
      { 'target.kind': 'seat', 'target.id': { $in: [...members] } },
    ],
  }).select('connectionId target audience').lean() as CandidateGrant[];

  const connectionIds = [...new Set(grants.filter((grant) => {
    const targetId = String(grant.target?.id || '');
    const audience = new Set((grant.audience || []).map(String));
    if (grant.target?.kind === 'pod') {
      return targetId === id && [...members].some((member) => audience.has(member));
    }
    return grant.target?.kind === 'seat' && members.has(targetId) && audience.has(targetId);
  }).map((grant) => String(grant.connectionId || '').trim()).filter(Boolean))];
  if (!connectionIds.length) return false;
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
  }).select('_id').lean();
  return connections.length > 0;
};
