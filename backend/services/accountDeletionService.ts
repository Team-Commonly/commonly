import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import SchedulerHeartbeatLease from '../models/SchedulerHeartbeatLease';
import User, { IUser } from '../models/User';
import AccountDeletion from '../models/AccountDeletion';
import File from '../models/File';
import Pod from '../models/Pod';
import DeviceAuthorization from '../models/DeviceAuthorization';
import OAuthLoginState from '../models/OAuthLoginState';
import AgentCredential from '../models/AgentCredential';
import Machine from '../models/Machine';
import { AgentInstallation } from '../models/AgentRegistry';
import { getObjectStore } from './objectStore';
import { disconnectUserSessionSockets } from './sessionSocketService';
import { stripe } from './billingService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../config/db-pg');

export class AccountDeletionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const revokeOwnedAccess = async (userId: string): Promise<void> => {
  disconnectUserSessionSockets(userId);
  await User.updateOne({ _id: userId }, {
    $set: { deviceTokens: [] },
    $unset: { apiToken: 1, apiTokenCreatedAt: 1, apiTokenScopes: 1 },
  });

  const credentials = await AgentCredential.find({ ownerUserId: userId }).select('_id').lean();
  await AgentCredential.revokeCascade(credentials.map((credential) => credential._id));
  await Machine.deleteMany({ ownerUserId: userId });
  await Pod.updateMany({ members: userId }, { $pull: { members: userId } });
  await AgentInstallation.updateMany(
    { installedBy: userId, status: 'active' },
    { $set: { status: 'paused' } },
  );
  await DeviceAuthorization.deleteMany({ userId });
  await OAuthLoginState.deleteMany({ userId });

};

const anonymizeChatAuthor = async (userId: string): Promise<void> => {
  // Shared messages remain. Their PG author join keeps an anonymous tombstone;
  // it must not preserve the deleted person's display name or avatar.
  if (pool) {
    await pool.query('DELETE FROM pod_members WHERE user_id = $1', [userId]);
    await pool.query(
      'UPDATE users SET username = $2, profile_picture = NULL, updated_at = $3 WHERE _id = $1',
      [userId, 'Deleted user', new Date()],
    );
  }
};

const deleteOwnedUploads = async (userId: string): Promise<void> => {
  // New keys carry an ownership namespace. This also finds bytes whose File
  // save failed after put, or whose metadata was removed during a late put.
  await getObjectStore().deletePrefix(`user-${userId}-`);
  const files = await File.find({ uploadedBy: userId }).select('_id fileName').lean();
  for (const file of files) {
    // Legacy keys have no namespace; retain metadata until deletion succeeds.
    // eslint-disable-next-line no-await-in-loop
    await getObjectStore().delete(file.fileName);
    // eslint-disable-next-line no-await-in-loop
    await File.deleteOne({ _id: file._id, uploadedBy: userId });
  }
};

// Only called after request re-authentication or for an already authorized,
// stale marker. Recovery retains a failed preflight for a later bounded retry.
const establishCleanupReceipt = async (user: IUser, releaseOnBillingFailure = true): Promise<void> => {
  const userId = String(user._id);
  // A receipt means billing preflight already succeeded. Otherwise claim the
  // non-admin row before Stripe. A stale claim recovers a crashed preflight;
  // the provider request is bounded below this five-minute lease.
  if (!await AccountDeletion.exists({ _id: userId })) {
    const claimedAt = new Date();
    const claimed = await User.updateOne({
      _id: userId, isBot: { $ne: true }, role: { $ne: 'admin' },
      $or: [{ accountDeletionRequestedAt: { $exists: false } },
        { accountDeletionRequestedAt: { $lt: new Date(claimedAt.getTime() - 300_000) } }],
    }, { $set: { accountDeletionRequestedAt: claimedAt } });
    if (claimed.matchedCount !== 1) {
      throw new AccountDeletionError(409, 'ACCOUNT_CHANGED',
        'Your account changed or deletion is already in progress. Try again shortly.');
    }
    try {
      if (user.billing?.subscriptionId && user.billing.subscriptionStatus !== 'canceled') {
        const client = stripe();
        if (!client) throw new Error('Billing is unavailable; account deletion cannot cancel the subscription');
        await client.subscriptions.cancel(user.billing.subscriptionId, {}, {
          idempotencyKey: `account-deletion-${userId}-${user.billing.subscriptionId}`,
          timeout: 30_000,
          maxNetworkRetries: 0,
        });
      }
    } catch (error) {
      // Release only this attempt's claim. Credentials and uploads are intact.
      if (releaseOnBillingFailure) {
        await User.updateOne({ _id: userId, accountDeletionRequestedAt: claimedAt },
          { $unset: { accountDeletionRequestedAt: 1 } });
      }
      throw error;
    }
    await AccountDeletion.updateOne({ _id: userId }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  }
};

export const ACCOUNT_DELETION_SWEEP_BATCH = 100;
const SWEEP_LEASE_ID = 'account-deletion-sweep';
const SWEEP_LEASE_MS = 120_000;

/** Bounded, fair retries retain intents until all late producers are fenced. */
export const sweepAccountDeletions = async (): Promise<void> => {
  const ownerId = randomUUID();
  const now = new Date();
  try {
    await SchedulerHeartbeatLease.findOneAndUpdate(
      { _id: SWEEP_LEASE_ID, expiresAt: { $lte: now } },
      { $set: { ownerId, expiresAt: new Date(now.getTime() + SWEEP_LEASE_MS) } },
      { upsert: true, new: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return;
    throw error;
  }
  const renewLease = async (): Promise<void> => {
    const renewed = await SchedulerHeartbeatLease.updateOne(
      { _id: SWEEP_LEASE_ID, ownerId },
      { $set: { expiresAt: new Date(Date.now() + SWEEP_LEASE_MS) } },
    );
    if (renewed.matchedCount !== 1) throw new Error('Account deletion sweep lease lost');
  };
  const errors: unknown[] = [];
  const failedIds: string[] = [];
  try {
    // Recover the gap between the authorized marker and receipt creation.
    // Fresh billing preflights are excluded. Existing receipts need no recovery.
    const stranded = await User.aggregate<IUser>([
      { $match: { accountDeletionRequestedAt: { $lt: new Date(Date.now() - 300_000) },
        role: { $ne: 'admin' }, isBot: { $ne: true } } },
      { $sort: { accountDeletionRequestedAt: 1, _id: 1 } },
      { $lookup: { from: AccountDeletion.collection.name, localField: '_id',
        foreignField: '_id', as: 'cleanupReceipt' } },
      { $match: { 'cleanupReceipt.0': { $exists: false } } },
      { $limit: ACCOUNT_DELETION_SWEEP_BATCH },
      { $unset: 'cleanupReceipt' },
    ]);
    for (const user of stranded) {
      // eslint-disable-next-line no-await-in-loop
      await renewLease();
      try {
        // eslint-disable-next-line no-await-in-loop
        await establishCleanupReceipt(user, false);
      } catch (error) {
        errors.push(error);
        failedIds.push(String(user._id));
      }
    }
    const receipts = await AccountDeletion.find().sort({ lastSweptAt: 1, _id: 1 })
      .limit(ACCOUNT_DELETION_SWEEP_BATCH).select('_id').lean();
    for (const receipt of receipts) {
      // Renew between receipts. If this worker lost its lease, stop starting
      // work; expiry recovers a crashed worker and deletes remain idempotent.
      // eslint-disable-next-line no-await-in-loop
      await renewLease();
      const userId = String(receipt._id);
      try {
        // eslint-disable-next-line no-await-in-loop
        await revokeOwnedAccess(userId);
        // eslint-disable-next-line no-await-in-loop
        await anonymizeChatAuthor(userId);
        // eslint-disable-next-line no-await-in-loop
        await deleteOwnedUploads(userId);
      } catch (error) {
        errors.push(error);
        failedIds.push(userId);
      }
      // Rotate failed receipts too: one persistent failure cannot starve the
      // remaining queue. Keep the intent, so every later round retries it.
      try {
        // eslint-disable-next-line no-await-in-loop
        await AccountDeletion.updateOne({ _id: receipt._id }, { $set: { lastSweptAt: new Date() } });
      } catch (error) {
        errors.push(error);
        failedIds.push(userId);
      }
    }
    if (errors.length) throw new AggregateError(errors, `Account deletion cleanup failed: ${failedIds.join(',')}`);
  } finally {
    await SchedulerHeartbeatLease.deleteOne({ _id: SWEEP_LEASE_ID, ownerId });
  }
};

/** Human deletion pauses owned runtimes, preserving independent agent User/memory rows. */
export const deleteOwnAccount = async (
  userId: string,
  bearer: string,
  password: unknown,
): Promise<void> => {
  const user = await User.findById(userId);
  if (!user || user.isBot) {
    throw new AccountDeletionError(403, 'HUMAN_ACCOUNT_REQUIRED', 'Only human accounts can use account deletion.');
  }
  if (user.password) {
    if (typeof password !== 'string' || !password || password.length > 1024) {
      throw new AccountDeletionError(401, 'PASSWORD_REQUIRED', 'Enter your password to delete your account.');
    }
    if (!await user.comparePassword(password)) {
      throw new AccountDeletionError(401, 'PASSWORD_REQUIRED', 'Incorrect password.');
    }
  } else {
    const claims = jwt.verify(bearer, process.env.JWT_SECRET!) as jwt.JwtPayload;
    const age = Math.floor(Date.now() / 1000) - claims.oauthAuthenticatedAt;
    if (String(claims.id) !== userId || !Number.isSafeInteger(claims.oauthAuthenticatedAt)
      || age < 0 || age > 300) {
      throw new AccountDeletionError(401, 'REAUTH_REQUIRED',
        'Sign in again with your OAuth provider, then confirm deletion within five minutes.');
    }
  }
  // Admins hand off their role before deleting. A separate count followed by
  // deletion lets two admins both pass and remove the final administrators.
  if (user.role === 'admin') {
    throw new AccountDeletionError(409, 'ADMIN_HANDOFF_REQUIRED',
      'Transfer administration and ask another admin to make this a member account before deleting it.');
  }

  await establishCleanupReceipt(user);
  await revokeOwnedAccess(userId);

  await deleteOwnedUploads(userId);

  await anonymizeChatAuthor(userId);
  await User.deleteOne({ _id: userId, isBot: { $ne: true }, role: { $ne: 'admin' } });
  disconnectUserSessionSockets(userId);
};
