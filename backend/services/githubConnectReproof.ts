/**
 * F172 HOLD 1: a Commonly Connect connection's access is proved again on every
 * write call, with the owner's CURRENT GitHub user token.
 *
 * The installation token the broker signs with does not depend on the owner's
 * rights: a person who loses push, or leaves the org, would otherwise keep
 * writing through Commonly for as long as the row exists. So before a write
 * parks, and again before an approved write runs, the same proof the create
 * route ran is run for the row's owner, installation and repository, and the
 * repository GitHub lists must still be the one recorded (`repositoryId`), not
 * another with the same name.
 *
 * A passing proof is remembered for PROOF_CACHE_MS per row so a burst of park
 * calls does not hammer GitHub. Execution passes `fresh`, which skips the
 * cache: an approval can come hours after the park, and the proof that
 * matters is the one at the moment of the write. Failures are never cached.
 *
 * Every refusal is `connection_unproven` (403), with the proof's own code in
 * `details.reason`, and nothing is written to GitHub. Tools rows (our own org,
 * admin-bound) are not re-proved.
 */
import { RoomGrantError } from './roomGrantService';
import {
  GithubConnectProofError,
  proveConnectRepository,
  type GithubConnectProofDeps,
} from './githubConnectProof';

export const PROOF_CACHE_MS = 60 * 1000;

interface CachedProof {
  until: number;
  key: string;
}

const proofCache = new Map<string, CachedProof>();

export interface ConnectProofSubject {
  app: 'tools' | 'connect';
  rowId?: string;
  ownerUserId?: string;
  installationId: string;
  owner: string;
  repo: string;
  repositoryId?: string;
}

const unproven = (reason: string, message: string): RoomGrantError => new RoomGrantError(
  'connection_unproven',
  `the connection owner's GitHub access could not be confirmed: ${message}`,
  403,
  { reason },
);

/** Tests only. */
export const _resetConnectProofCache = (): void => { proofCache.clear(); };

export const assertConnectStillProven = async (
  subject: ConnectProofSubject,
  options: { fresh?: boolean; deps?: Partial<GithubConnectProofDeps>; now?: () => number } = {},
): Promise<void> => {
  if (subject.app !== 'connect') return;
  const now = (options.now || Date.now)();
  const rowId = String(subject.rowId || '');
  const ownerUserId = String(subject.ownerUserId || '');
  const repositoryId = String(subject.repositoryId || '');
  // A Connect row with no recorded repository or owner cannot be checked, so it is refused.
  if (!rowId || !ownerUserId || !repositoryId) {
    throw unproven('connection_incomplete', 'the connection is missing its proof record');
  }
  const key = [ownerUserId, subject.installationId, subject.owner, subject.repo, repositoryId].join('\u0000');
  const cached = proofCache.get(rowId);
  if (!options.fresh && cached && cached.key === key && cached.until > now) return;
  proofCache.delete(rowId);
  try {
    await proveConnectRepository({
      userId: ownerUserId,
      installationId: subject.installationId,
      owner: subject.owner,
      repo: subject.repo,
      expectedRepositoryId: repositoryId,
    }, options.deps);
  } catch (error) {
    if (error instanceof GithubConnectProofError) throw unproven(error.code, error.message);
    throw unproven('proof_failed', 'the check could not complete');
  }
  proofCache.set(rowId, { until: now + PROOF_CACHE_MS, key });
};
