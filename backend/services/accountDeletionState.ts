import User from '../models/User';
import AccountDeletion from '../models/AccountDeletion';

/** The live marker covers intent creation; the receipt survives removal of User. */
export const isAccountDeleting = async (userId: unknown): Promise<boolean> => {
  if (!userId) return false;
  return Boolean(await AccountDeletion.exists({ _id: userId })
    || await User.exists({ _id: userId, accountDeletionRequestedAt: { $exists: true } }));
};
