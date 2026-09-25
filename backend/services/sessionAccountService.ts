import User from '../models/User';

/**
 * The one live-row read behind every user-session verifier.
 *
 * A user session is a 7-day JWT carrying `{ id }` and nothing else about the
 * account, so every verifier has to answer "is this still an account?" from the
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
 * `banned` and `isBot` are read together and never defaulted: a verifier that
 * forgets one of the two fields in its projection reads `undefined` and refuses
 * nothing, which is why the fields are selected here rather than at each call
 * site.
 */
export type SessionAccountRefusal = 'missing' | 'banned' | 'bot';

export interface SessionAccount {
  _id?: unknown;
  banned?: boolean;
  isBot?: boolean;
}

export const loadSessionAccount = async (userId: string): Promise<SessionAccount | null> => {
  const account = await User.findById(userId).select('banned isBot').lean();
  return (account as SessionAccount | null) || null;
};

/**
 * `null` means the row is a usable human session. Every other value is a
 * refusal the caller must express in its own protocol (HTTP status, handshake
 * error), because the vocabulary is shared and the rendering is not.
 */
export const sessionRefusal = (account: SessionAccount | null): SessionAccountRefusal | null => {
  if (!account) return 'missing';
  if (account.banned) return 'banned';
  if (account.isBot) return 'bot';
  return null;
};
