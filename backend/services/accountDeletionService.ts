import jwt from 'jsonwebtoken';
import User from '../models/User';
import AccountDeletion from '../models/AccountDeletion';
import File from '../models/File';
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
  const credentials = await AgentCredential.find({ ownerUserId: userId }).select('_id').lean();
  await AgentCredential.revokeCascade(credentials.map((credential) => credential._id));
  await Machine.deleteMany({ ownerUserId: userId });
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

/** Retried by the scheduler even after the human row has been removed. */
export const sweepAccountDeletions = async (): Promise<void> => {
  const receipts = AccountDeletion.find().select('_id').lean().cursor();
  for await (const receipt of receipts) {
    const userId = String(receipt._id);
    // Reapply revocation/redaction too: a request authenticated before deletion
    // can finish a credential mint or profile mirror after the first scan.
    await revokeOwnedAccess(userId);
    await anonymizeChatAuthor(userId);
    await deleteOwnedUploads(userId);
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
  if (user.role === 'admin' && await User.countDocuments({ role: 'admin', isBot: { $ne: true } }) <= 1) {
    throw new AccountDeletionError(409, 'LAST_ADMIN', 'Assign another administrator before deleting your account.');
  }

  // Cancel billing before destroying the linkage needed to stop future charges.
  if (user.billing?.subscriptionId && user.billing.subscriptionStatus !== 'canceled') {
    const client = stripe();
    if (!client) throw new Error('Billing is unavailable; account deletion cannot cancel the subscription');
    await client.subscriptions.cancel(user.billing.subscriptionId, {}, {
      idempotencyKey: `account-deletion-${userId}`,
    });
  }

  // Durable marker closes upload races and survives a storage failure. Keep the
  // human row until cleanup succeeds so the same re-authenticated request can retry.
  await User.updateOne({ _id: userId }, {
    $set: { accountDeletionRequestedAt: new Date(), deviceTokens: [] },
    $unset: { apiToken: 1, apiTokenCreatedAt: 1, apiTokenScopes: 1 },
  });
  await AccountDeletion.updateOne({ _id: userId }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  await revokeOwnedAccess(userId);

  await deleteOwnedUploads(userId);

  await anonymizeChatAuthor(userId);
  await User.deleteOne({ _id: userId, isBot: { $ne: true } });
  disconnectUserSessionSockets(userId);
};
