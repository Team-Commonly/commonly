import mongoose, { Document, Schema, Types } from 'mongoose';

export type OAuthProvider = 'x';

export interface IOAuthState extends Document {
  provider: OAuthProvider;
  state: string;
  userId: Types.ObjectId;
  codeVerifier: string;
  redirectPath: string;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const OAuthStateSchema = new Schema<IOAuthState>(
  {
    provider: { type: String, required: true, enum: ['x'], index: true },
    state: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    codeVerifier: { type: String, required: true },
    redirectPath: { type: String, default: '/admin/integrations/global' },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'oauth_states' },
);

export default mongoose.model<IOAuthState>('OAuthState', OAuthStateSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
