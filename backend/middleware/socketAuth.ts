import jwt from 'jsonwebtoken';
import { loadSessionAccount, sessionRefusal } from '../services/sessionAccountService';

/**
 * Socket.io handshake authentication, lifted out of `server.ts` so the row read
 * it performs is the same one the Express middleware and the uploads bearer
 * perform — and so it can be witnessed (TASK-133).
 *
 * It used to verify the JWT and stop there: a valid signature was the whole
 * check, so a session whose account had since been banned, deleted or converted
 * into an agent could subscribe to pod rooms and `sendMessage` for the token's
 * remaining lifetime. `banned` was enforced on the HTTP surface and not here;
 * `isBot` was enforced nowhere.
 */
const sessionError = (reason: string) => new Error(`Authentication error: ${reason}`);

export const socketAuthMiddleware = async (socket: any, next: (err?: Error) => void): Promise<void> => {
  const { token } = socket?.handshake?.auth || {};
  if (!token) {
    console.error('Socket auth error: Token not provided');
    return next(sessionError('Token not provided'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as Record<string, unknown>;

    // Handle both token formats: { id: user._id } or { user: { id: user._id } }
    const userId = (decoded.id || (decoded.user as Record<string, unknown>)?.id) as string | undefined;

    if (!userId) {
      console.error('Socket auth error: Invalid token structure');
      return next(sessionError('Invalid token structure'));
    }

    const refusal = sessionRefusal(await loadSessionAccount(userId));
    if (refusal === 'bot') {
      console.error('Socket auth error: agent account cannot open a user session');
      return next(sessionError('Agent accounts authenticate with their runtime token'));
    }
    if (refusal) {
      // A missing row and a banned one are the same answer to the client: the
      // distinction is for the operator, and the error message is not the place
      // to say whether an account exists.
      console.error(`Socket auth error: session not usable (${refusal})`);
      return next(sessionError('Invalid token'));
    }

    socket.userId = userId;
    return next();
  } catch (err: any) {
    console.error('Socket auth error:', err.message);
    return next(sessionError('Invalid token'));
  }
};

export default socketAuthMiddleware;
