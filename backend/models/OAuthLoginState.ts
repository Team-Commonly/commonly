import mongoose, { Document, Schema, Types } from 'mongoose';

// One row per social-login attempt. Lives for the length of the OAuth
// round-trip and is deliberately separate from OAuthState (the X/Twitter
// integration model) — that flow authorizes an existing user's integration,
// this one authenticates a possibly-not-yet-existing user.
//
// Lifecycle: created at /oauth/:provider/start (state minted) → validated +
// marked used at /oauth/:provider/callback (userId + one-time exchangeCode
// stamped) → consumed at /oauth/exchange (JWT issued, exchangedAt stamped).
// The TTL index reaps abandoned attempts.

export type OAuthLoginProvider = 'github' | 'google';

export interface IOAuthLoginState extends Document {
  provider: OAuthLoginProvider;
  state: string;
  // Optional invite code captured at /start so an OAuth signup can satisfy
  // the invite-only gate without a form round-trip.
  invitationCode?: string;
  // Frontend path to land on after login completes. Must be app-relative.
  next?: string;
  userId?: Types.ObjectId | null;
  exchangeCode?: string | null;
  exchangeExpiresAt?: Date | null;
  usedAt?: Date | null;
  exchangedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OAuthLoginStateSchema = new Schema<IOAuthLoginState>(
  {
    provider: { type: String, required: true, enum: ['github', 'google'], index: true },
    state: { type: String, required: true, unique: true, index: true },
    invitationCode: { type: String, default: '' },
    next: { type: String, default: '/v2' },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    exchangeCode: { type: String, default: null, unique: true, sparse: true },
    exchangeExpiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    exchangedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true, collection: 'oauth_login_states' },
);

export default mongoose.model<IOAuthLoginState>('OAuthLoginState', OAuthLoginStateSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
