/**
 * Express Request augmentation.
 *
 * Adds fields set by Commonly-specific authentication middleware so
 * TypeScript-aware routes don't need to cast req as any.
 *
 * NOTE: Many controllers define their own `interface AuthRequest extends Request`
 * with a local `user` override. Those patterns are intentionally NOT unified here —
 * that migration is Track A Batch 2 (controllers). This file only adds fields
 * that are genuinely missing from the global Request type.
 *
 * Set by middleware/agentRuntimeAuth.js:
 *   req.agentUser — populated User document for the calling agent
 *   req.userId    — user._id as string (also set by verifyToken)
 *   req.token     — raw JWT string (also set by verifyToken)
 */
declare global {
  namespace Express {
    interface Request {
      /** User _id as string — set by verifyToken and agentRuntimeAuth middleware */
      userId?: string;

      /** Raw JWT string — set by verifyToken middleware */
      token?: string;

      /** Populated User document for the calling agent — set by agentRuntimeAuth middleware */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentUser?: Record<string, any> & { _id: any };
    }
  }
}

export {};
