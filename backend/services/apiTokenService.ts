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

// Whether the stored row holds a token, read at decision time rather than from
// a document loaded earlier. A retired plaintext form counts: minting over it
// would erase a bearer the backfill can still restore. Reading the digest here
// too means a backfill that finished after the caller loaded the row is seen.
// Only an explicit rotation replaces either. Presence only; nothing is loaded.
export const holdsStoredApiToken = async (userId: unknown): Promise<boolean> => (
  Boolean(await User.exists({
    _id: userId,
    $or: [{ apiTokenHash: { $type: 'string' } }, { apiToken: { $type: 'string' } }],
  }))
);
