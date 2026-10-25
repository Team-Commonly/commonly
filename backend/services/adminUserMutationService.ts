import { randomUUID } from 'crypto';
import AdminUserMutationLock from '../models/AdminUserMutationLock';
import User from '../models/User';

export class AdminUserMutationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const LOCK_ID = 'global-admin-user-mutations';
const writeConcern = { w: 'majority' as const, wtimeout: 5000 };

// Standalone Mongo is supported. A primary-key insert serializes online role,
// ban and deletion handlers across processes without requiring transactions.
// A crash fails closed until operator recovery; see docs/runbooks/admin-user-mutation-lock.md.
export const withAdminUserMutationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const owner = randomUUID();
  try {
    await AdminUserMutationLock.create([{ _id: LOCK_ID, owner, acquiredAt: new Date() }], { writeConcern });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new AdminUserMutationError(503, 'ADMIN_MUTATION_BUSY',
        'Another administrator change is in progress. Retry shortly; persistent refusal needs operator recovery.');
    }
    throw error;
  }
  // A rejected write can still have an unknown outcome. Do not release on
  // callback failure: the original database write might complete later.
  const value = await operation();
  const released = await AdminUserMutationLock.deleteOne({ _id: LOCK_ID, owner }, { writeConcern });
  if (released.deletedCount !== 1) {
    throw new AdminUserMutationError(503, 'ADMIN_MUTATION_LOCK_LOST',
      'Administrator mutation lock changed unexpectedly.');
  }
  return value;
};

// The scheduler's applying purge uses the same lock without a human actor.
// HTTP callers must use this authorization-checking entry point.
export const withAdminUserMutation = async <T>(actorId: string, operation: () => Promise<T>): Promise<T> => {
  const outcome = await withAdminUserMutationLock(async () => {
    // The request may have passed adminAuth before a competing demotion. Read
    // authorization again only after acquiring the shared mutation lock.
    const actor = await User.findById(actorId);
    if (!actor || actor.role !== 'admin' || actor.banned || actor.isBot) {
      // A known refusal has not attempted a write, so normal unlock is safe.
      return { ok: false as const, error: new AdminUserMutationError(403, 'ADMIN_ACCESS_CHANGED',
        'Administrator access changed. Sign in again.') };
    }
    return { ok: true as const, value: await operation() };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};
