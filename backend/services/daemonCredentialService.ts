// ADR-026 D4: daemon credentials are intentionally a different auth shape
// from cm_agent_* runtime tokens. They identify a machine lifecycle daemon,
// never an agent identity, and only carry the scopes enumerated here.
import { Types } from 'mongoose';
import AgentCredential from '../models/AgentCredential';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hash, randomSecret } = require('../utils/secret') as {
  hash: (value: string) => string;
  randomSecret: (bytes: number) => string;
};

export const DAEMON_SCOPES = [
  'machine:heartbeat',
  'agent:adopt',
  'agent:runtime-token:mint',
] as const;

export type DaemonScope = (typeof DAEMON_SCOPES)[number];

export interface DaemonCredential {
  _id: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  machineId: string;
  scopes: string[];
}

export async function issueDaemonCredential({
  ownerUserId,
  machineId,
  name,
}: {
  ownerUserId: Types.ObjectId | string;
  machineId: string;
  name: string;
}): Promise<{ credential: DaemonCredential; token: string }> {
  const token = `cm_daemon_${randomSecret(32)}`;
  const credential = await AgentCredential.create({
    tokenHash: hash(token),
    kind: 'daemon',
    ownerUserId,
    machineId,
    label: `Daemon: ${name}`,
    scopes: DAEMON_SCOPES,
  });
  return { credential: credential as DaemonCredential, token };
}

export async function authenticateDaemonCredential(
  token: string | undefined,
  requiredScope: DaemonScope,
): Promise<DaemonCredential | null> {
  if (!token || !token.startsWith('cm_daemon_')) return null;

  const credential = await AgentCredential.findOne({
    tokenHash: hash(token),
    kind: 'daemon',
  });
  if (!credential || credential.status !== 'active' || !credential.machineId) return null;
  if (credential.expiresAt && credential.expiresAt < new Date()) return null;
  if (!credential.scopes.includes(requiredScope)) return null;

  AgentCredential.updateOne(
    { _id: credential._id },
    { $set: { lastUsedAt: new Date() } },
  ).catch((err: Error) => console.warn('Failed to update daemon credential usage:', err.message));

  return credential as DaemonCredential;
}

module.exports = {
  DAEMON_SCOPES,
  authenticateDaemonCredential,
  issueDaemonCredential,
};
Object.assign(module.exports, exports);
