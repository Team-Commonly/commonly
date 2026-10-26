import User from '../models/User';

const { hash, safeEqual } = require('../utils/secret');

// Indexed selection followed by fixed-size verification, including misses.
export const findApiTokenUser = async (token: string) => {
  const digest: string = hash(token);
  const projection = '_id username email role apiTokenScopes apiTokenCreatedAt '
    + 'banned accountDeletionRequestedAt +apiTokenHash +apiToken';
  const hashed = await User.findOne({ apiTokenHash: digest }).select(projection);
  // TASK-558: remove after verified staging and production backfill.
  // See docs/runbooks/api-token-storage.md for the compatibility removal gate.
  const legacy = hashed ? null : await User.findOne({
    apiToken: token, apiTokenHash: { $exists: false },
  }).select(projection);
  const user = hashed || legacy;
  const expected = user?.apiTokenHash || (user?.apiToken ? hash(user.apiToken) : '0'.repeat(64));
  const valid = safeEqual(digest, expected);
  return user && valid ? user : null;
};
