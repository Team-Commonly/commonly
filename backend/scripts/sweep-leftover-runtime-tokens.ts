/**
 * Remove installation-only runtime-token copies left by pre-rotation mints.
 *
 * Dry run is the default:
 *   npm run sweep:leftover-runtime-tokens
 * Apply the measured, stale-only candidates:
 *   npm run sweep:leftover-runtime-tokens -- --apply
 *
 * The sweep never reads or writes local token files. It only removes bearer
 * hashes from active AgentInstallation rows and revokes their runtime ledger
 * rows. Tokens used in the last seven days are left for an operator to review.
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';
import AgentCredential from '../models/AgentCredential';
import { AgentInstallation } from '../models/AgentRegistry';
import User from '../models/User';
import { revokeRuntimeCredentials } from '../routes/registry/tokens';

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type TokenCopy = {
  tokenHash?: string;
  lastUsedAt?: Date | string | null;
};

type InstallationRow = {
  agentName: string;
  instanceId?: string;
  runtimeTokens?: TokenCopy[];
};

type CredentialRow = {
  tokenHash: string;
  status: string;
  lastUsedAt?: Date | string | null;
};

type TokenCandidate = {
  hash: string;
  copies: number;
  newestLastUsedAt: Date | null;
  recentlyUsed: boolean;
  revoked: boolean;
};

export type LeftoverRuntimeTokenIdentity = {
  agentName: string;
  instanceId: string;
  count: number;
  skippedRecent: number;
  newestLastUsedAt: Date | null;
};

export type SweepLeftoverRuntimeTokensResult = {
  apply: boolean;
  cutoff: Date;
  identities: LeftoverRuntimeTokenIdentity[];
  candidateHashes: number;
  copiesToPull: number;
  copiesSkippedRecent: number;
  installationRowsChanged: number;
  credentialsRevoked: number;
};

const normalize = (value: unknown, fallback = 'default'): string => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
};

const identityKey = (agentName: unknown, instanceId: unknown): string => (
  `${normalize(agentName, '')}:${normalize(instanceId)}`
);

const dateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const newestDate = (left: Date | null, right: Date | null): Date | null => {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
};

const buildCandidates = (
  installations: InstallationRow[],
  users: any[],
  credentials: CredentialRow[],
  cutoff: Date,
) => {
  const userHashes = new Set<string>();
  for (const user of users) {
    for (const token of user.agentRuntimeTokens || []) {
      if (token?.tokenHash) userHashes.add(token.tokenHash);
    }
  }

  const credentialByHash = new Map<string, CredentialRow>();
  for (const credential of credentials) credentialByHash.set(credential.tokenHash, credential);

  const byIdentity = new Map<string, Map<string, TokenCandidate>>();
  for (const installation of installations) {
    const agentName = normalize(installation.agentName, '');
    const instanceId = normalize(installation.instanceId);
    const key = identityKey(agentName, instanceId);
    if (!byIdentity.has(key)) byIdentity.set(key, new Map());
    const tokensByHash = byIdentity.get(key)!;
    for (const token of installation.runtimeTokens || []) {
      const hash = token?.tokenHash;
      if (!hash) continue;
      const previous = tokensByHash.get(hash) || {
        hash,
        copies: 0,
        newestLastUsedAt: null,
        recentlyUsed: false,
        revoked: false,
      };
      previous.copies += 1;
      previous.newestLastUsedAt = newestDate(previous.newestLastUsedAt, dateOrNull(token.lastUsedAt));
      const credential = credentialByHash.get(hash);
      previous.newestLastUsedAt = newestDate(previous.newestLastUsedAt, dateOrNull(credential?.lastUsedAt));
      previous.recentlyUsed = Boolean(previous.newestLastUsedAt && previous.newestLastUsedAt >= cutoff);
      previous.revoked = credential?.status === 'revoked';
      tokensByHash.set(hash, previous);
    }
  }

  const identities: LeftoverRuntimeTokenIdentity[] = [];
  const selectedHashesByIdentity = new Map<string, string[]>();
  let copiesToPull = 0;
  let copiesSkippedRecent = 0;
  for (const [key, tokensByHash] of byIdentity) {
    const [agentName, instanceId] = key.split(':');
    const selectedHashes: string[] = [];
    let count = 0;
    let skippedRecent = 0;
    let newestLastUsedAt: Date | null = null;
    for (const candidate of tokensByHash.values()) {
      newestLastUsedAt = newestDate(newestLastUsedAt, candidate.newestLastUsedAt);
      // A token hash should belong to one identity, but excluding it if it is
      // present on any bot User row is the safe failure mode for a malformed
      // duplicate: never pull a bearer that still has a User auth path.
      if (userHashes.has(candidate.hash) || candidate.revoked) continue;
      if (candidate.recentlyUsed) {
        skippedRecent += candidate.copies;
        copiesSkippedRecent += candidate.copies;
        continue;
      }
      selectedHashes.push(candidate.hash);
      count += candidate.copies;
      copiesToPull += candidate.copies;
    }
    if (count || skippedRecent) {
      identities.push({ agentName, instanceId, count, skippedRecent, newestLastUsedAt });
      selectedHashesByIdentity.set(key, selectedHashes);
    }
  }

  identities.sort((left, right) => (
    `${left.agentName}:${left.instanceId}`.localeCompare(`${right.agentName}:${right.instanceId}`)
  ));
  return {
    identities,
    selectedHashesByIdentity,
    candidateHashes: Array.from(selectedHashesByIdentity.values()).reduce((total, hashes) => total + hashes.length, 0),
    copiesToPull,
    copiesSkippedRecent,
  };
};

const modifiedCount = (result: any): number => Number(result?.modifiedCount ?? result?.nModified ?? 0);

/**
 * Find installation-only runtime bearers and, when requested, remove only
 * candidates whose latest observed use is outside the seven-day safety window.
 */
export const sweepLeftoverRuntimeTokens = async (
  options: { apply?: boolean } = {},
): Promise<SweepLeftoverRuntimeTokensResult> => {
  const apply = options.apply === true;
  const cutoff = new Date(Date.now() - RECENT_WINDOW_MS);
  const installations = await AgentInstallation.find({
    status: 'active',
    'runtimeTokens.0': { $exists: true },
  }).select('agentName instanceId runtimeTokens').lean() as InstallationRow[];
  const users = await User.find({ isBot: true })
    .select('agentRuntimeTokens')
    .lean() as any[];
  const allHashes = Array.from(new Set(
    installations.flatMap((installation) => (installation.runtimeTokens || [])
      .map((token) => token?.tokenHash)
      .filter(Boolean) as string[]),
  ));
  const credentials = allHashes.length
    ? await AgentCredential.find({ tokenHash: { $in: allHashes }, kind: 'runtime' })
      .select('tokenHash status lastUsedAt')
      .lean() as CredentialRow[]
    : [];
  const plan = buildCandidates(installations, users, credentials, cutoff);

  let installationRowsChanged = 0;
  let credentialsRevoked = 0;
  if (apply) {
    for (const [key, hashes] of plan.selectedHashesByIdentity) {
      if (!hashes.length) continue;
      const [agentName, instanceId] = key.split(':');
      const pulled = await AgentInstallation.updateMany(
        { agentName, instanceId, status: 'active' },
        {
          $pull: {
            runtimeTokens: {
              tokenHash: { $in: hashes },
              $or: [
                { lastUsedAt: { $exists: false } },
                { lastUsedAt: null },
                { lastUsedAt: { $lt: cutoff } },
              ],
            },
          },
        },
      );
      installationRowsChanged += modifiedCount(pulled);
    }
    if (plan.candidateHashes) {
      const revoked = await revokeRuntimeCredentials(
        Array.from(plan.selectedHashesByIdentity.values()).flat(),
        {
          $or: [
            { lastUsedAt: { $exists: false } },
            { lastUsedAt: null },
            { lastUsedAt: { $lt: cutoff } },
          ],
        },
      );
      credentialsRevoked = modifiedCount(revoked);
    }
  }

  return {
    apply,
    cutoff,
    identities: plan.identities,
    candidateHashes: plan.candidateHashes,
    copiesToPull: plan.copiesToPull,
    copiesSkippedRecent: plan.copiesSkippedRecent,
    installationRowsChanged,
    credentialsRevoked,
  };
};

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await sweepLeftoverRuntimeTokens({ apply: process.argv.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.apply) console.log('DRY RUN — no runtime tokens changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('leftover runtime-token sweep failed:', error);
    process.exit(1);
  });
}
