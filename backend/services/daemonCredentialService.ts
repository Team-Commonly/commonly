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
  'agents:adopt',
] as const;

// D4: forgotten-machine credentials are long lived, not permanent.
export const DAEMON_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

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
    expiresAt: new Date(Date.now() + DAEMON_CREDENTIAL_LIFETIME_MS),
  });
  return { credential: credential as DaemonCredential, token };
}

module.exports = {
  DAEMON_SCOPES,
  issueDaemonCredential,
};
Object.assign(module.exports, exports);
