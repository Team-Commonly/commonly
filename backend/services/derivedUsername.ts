// A username for a signup that didn't type one (TASK-290 A): the register page
// asks only for an email and a password, and the handle comes from the email.
//
// The handle has to work wherever a person is @-mentioned, so it keeps to what
// every mention reader accepts: a letter or digit, then letters, digits and
// hyphens, at least 2 long (agentMentionService needs 2, agentMessageService
// stops at 40). A dot or an underscore would cut the mention short.
//
// Free means: no other account holds the name in any case ("Sam" holds "sam"),
// and it isn't reserved for an agent install (TASK-133 b), the check register
// runs on a typed name. The case-insensitive match is done by the query's
// collation, which the unique index on username can't serve, so it runs on the
// model's collated index, username_label. An OAuth signup (oauthController)
// derives through the same helpers, starting from the provider's handle when it
// gives one (F595).
const crypto = require('crypto');
const User = require('../models/User');
const AgentIdentityService = require('./agentIdentityService');

// The account-label comparison userController uses.
const ACCOUNT_LABEL_COLLATION = { locale: 'en', strength: 2 };
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Leaves room for the "-xxxx" suffix under the 40-character mention limit.
const MAX_BASE_LENGTH = 30;

/** Any handle as a username base: lowercased, runs of anything outside [a-z0-9] made one hyphen. */
const usernameBaseFromHandle = (handle: unknown): string => String(handle || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+/, '')
  .slice(0, MAX_BASE_LENGTH)
  .replace(/-+$/, '');

/** The email's local part as a handle: plus-tag dropped, runs of anything else made one hyphen. */
const usernameBaseFromEmail = (email: unknown): string => usernameBaseFromHandle(
  String(email || '').split('@')[0].split('+')[0],
);

const isValidUsername = (candidate: unknown): candidate is string => (
  typeof candidate === 'string' && USERNAME_PATTERN.test(candidate)
);

const isFreeUsername = async (candidate: string, excludeUserId?: unknown): Promise<boolean> => {
  if (await AgentIdentityService.resolveAccountNameConflict({ username: candidate })) return false;
  return !await User.exists({
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
    $or: [{ username: candidate }, { previousUsernames: candidate }],
  }).collation(ACCOUNT_LABEL_COLLATION);
};

/** A free username from a base: the base itself, or that plus a short suffix when taken or too short. */
const deriveUsernameFromBase = async (base: string): Promise<string> => {
  if (base.length >= 2 && await isFreeUsername(base)) return base;
  const stem = base || 'user';
  for (let i = 0; i < 5; i += 1) {
    const candidate = `${stem}-${crypto.randomBytes(2).toString('hex')}`;
    // eslint-disable-next-line no-await-in-loop
    if (await isFreeUsername(candidate)) return candidate;
  }
  // 30 + 1 + 8 stays under 40.
  return `${stem}-${crypto.randomBytes(4).toString('hex')}`;
};

/** A free username from the email: its local part, or that plus a short suffix when taken or too short. */
const deriveUsernameFromEmail = async (email: unknown): Promise<string> => (
  deriveUsernameFromBase(usernameBaseFromEmail(email))
);

/**
 * A free username for an OAuth signup: the provider's handle (a GitHub login)
 * when it cleans to 2+ characters, else the email exactly as register derives it.
 */
const deriveUsernameFromHandleOrEmail = async (handle: unknown, email: unknown): Promise<string> => {
  const handleBase = usernameBaseFromHandle(handle);
  return deriveUsernameFromBase(handleBase.length >= 2 ? handleBase : usernameBaseFromEmail(email));
};

module.exports = {
  usernameBaseFromHandle,
  usernameBaseFromEmail,
  deriveUsernameFromEmail,
  deriveUsernameFromHandleOrEmail,
  isValidUsername,
  isFreeUsername,
  ACCOUNT_LABEL_COLLATION,
};

export {};
