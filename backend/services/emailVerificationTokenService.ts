import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const PURPOSE = 'email-verification';

// Domain separation keeps a session JWT from authorizing an email change,
// even though both token families originate from the deployment JWT secret.
const verificationSecret = (): string => crypto
  .createHmac('sha256', process.env.JWT_SECRET!)
  .update(PURPOSE)
  .digest('hex');

export const issueEmailVerificationToken = (userId: unknown): string => jwt.sign(
  { id: userId, purpose: PURPOSE },
  verificationSecret(),
  { expiresIn: '1d' },
);

export const verifyEmailVerificationToken = (token: string): string => {
  const decoded = jwt.verify(token, verificationSecret());
  if (typeof decoded === 'string' || decoded.purpose !== PURPOSE || typeof decoded.id !== 'string') {
    throw new Error('Invalid email verification token');
  }
  return decoded.id;
};
