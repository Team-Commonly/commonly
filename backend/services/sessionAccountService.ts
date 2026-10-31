import User from '../models/User';
import { isInstanceAccessRestricted, isInstanceEmailAllowed } from './instanceAccessPolicy';

/**
 * The one live-row read behind every user-session verifier.
 *
 * A user session is a 7-day JWT carrying identity and a revocable version,
 * so every verifier has to answer "is this still an account?" from the
 * database. Three verifiers do that today — the Express middleware
 * (`middleware/auth.ts`), the Socket.io handshake (`middleware/socketAuth.ts`)
 * and the attachment bearer (`routes/uploads.ts`) — and before this service
 * each one answered a different question: the middleware read `banned`, and the
 * socket and the uploads bearer read nothing at all.
 *
 * `isBot` is the new term (TASK-133). Agent rows are Users too, and a bot row
 * that also carries a password hash is authenticated by the password login
 * (`authController.ts` login had no bot filter; the two recovery paths beside it
 * did) and then accepted by every session verifier, because a bot row is not
 * banned and carries no marker any of them looked at. One definition, called by
 * all three, is the only way that stays true — a fourth verifier that recomputes
 * the predicate will drift.
 *
 * `banned`, `isBot`, and `tokenVersion` are read together: a verifier that
 * forgets one of the two fields in its projection reads `undefined` and refuses
 * nothing, which is why the fields are selected here rather than at each call
 * site.
 */
export type SessionAccountRefusal = 'missing' | 'banned' | 'bot' | 'restricted' | 'deleting';
export type SessionTokenRefusal = SessionAccountRefusal | 'revoked';

export interface SessionAccount {
  _id?: unknown;
  banned?: boolean;
  isBot?: boolean;
  username?: string;
  email?: string;
  role?: string;
  tokenVersion?: number;
  accountDeletionRequestedAt?: Date;
}

/** Same term for the cm_ bearer branch, which reads its own user row. */
export const isAccountInstanceRestricted = (email: unknown): boolean => (
  isInstanceAccessRestricted() && !isInstanceEmailAllowed(email)
);

export const loadSessionAccount = async (userId: string): Promise<SessionAccount | null> => {
  // Express auth also needs identity fields for the same req.user shape as
  // API-token auth. Keep one live-row read for all session verifiers.
  const account = await User.findById(userId)
    .select('banned isBot username email role tokenVersion accountDeletionRequestedAt').lean();
  return (account as SessionAccount | null) || null;
};

/**
 * `null` means the row is a usable human session. Every other value is a
 * refusal the caller must express in its own protocol (HTTP status, handshake
 * error), because the vocabulary is shared and the rendering is not.
 */
export function sessionRefusal(account: SessionAccount | null): SessionAccountRefusal | null;
export function sessionRefusal(account: SessionAccount | null, claims: Record<string, unknown>): SessionTokenRefusal | null;
export function sessionRefusal(
  account: SessionAccount | null,
  claims?: Record<string, unknown>,
): SessionTokenRefusal | null {
  if (!account) return 'missing';
  if (account.banned) return 'banned';
  if (account.isBot) return 'bot';
  // The sign-in allowlist gates register and login only; without this term a
  // session minted before the list existed (or for a since-removed address)
  // stays valid until it expires. Unrestricted instances skip the term, and a
  // row with no email fails shut once the list is on.
  if (isInstanceAccessRestricted() && !isInstanceEmailAllowed(account.email)) return 'restricted';
  // Pre-deploy JWTs have no claim. They represent version zero and remain
  // usable only until the first revoke. A malformed explicit claim fails shut.
  if (claims && (claims.tokenVersion === undefined ? 0 : claims.tokenVersion) !== (account.tokenVersion ?? 0)) {
    return 'revoked';
  }
  if (account.accountDeletionRequestedAt) return 'deleting';
  return null;
}
