import User from '../models/User';

const { hash, safeEqual } = require('../utils/secret');

// Indexed selection followed by fixed-size verification, including misses.
export const findApiTokenUser = async (token: string) => {
  const digest: string = hash(token);
  const projection = '_id username email role isBot verified apiTokenScopes apiTokenCreatedAt '
    + 'banned accountDeletionRequestedAt +apiTokenHash';
  // Digest only. The plaintext reader was removed once staging and production
  // both measured zero legacy rows (docs/runbooks/api-token-storage.md).
  const user = await User.findOne({ apiTokenHash: digest }).select(projection);
  const expected = user?.apiTokenHash || '0'.repeat(64);
  const valid = safeEqual(digest, expected);
  return user && valid ? user : null;
};
