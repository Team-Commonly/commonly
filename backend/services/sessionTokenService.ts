import jwt from 'jsonwebtoken';

const SESSION_TOKEN_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ABSOLUTE_DAYS = 30;

export const absoluteSessionSeconds = (): number => {
  const days = Number(process.env.SESSION_ABSOLUTE_LIFETIME_DAYS);
  return (Number.isSafeInteger(days) && days > 0 ? days : DEFAULT_ABSOLUTE_DAYS) * 24 * 60 * 60;
};

/** Keep the original sign-in time when renewing a browser session. */
export const issueSessionToken = (
  user: { _id: unknown; tokenVersion?: number },
  sessionStartedAt?: number,
): string | null => {
  const now = Math.floor(Date.now() / 1000);
  const startedAt = sessionStartedAt === undefined ? now : sessionStartedAt;
  if (!Number.isSafeInteger(startedAt) || startedAt > now || startedAt <= 0) return null;
  const remaining = startedAt + absoluteSessionSeconds() - now;
  if (remaining <= 0) return null;
  return jwt.sign({
    id: user._id,
    tokenVersion: user.tokenVersion ?? 0,
    sessionStartedAt: startedAt,
  }, process.env.JWT_SECRET!, { expiresIn: Math.min(SESSION_TOKEN_SECONDS, remaining) });
};
