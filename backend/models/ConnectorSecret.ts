import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * Encrypted connector credential material.
 *
 * Integration rows keep only this document's id in `config.botTokenRef`; the
 * token itself must never be serialised through an Integration route.
 */
export interface IConnectorSecret extends Document {
  integrationId: Types.ObjectId;
  provider: string;
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  createdAt: Date;
  updatedAt: Date;
}

const ConnectorSecretSchema = new Schema<IConnectorSecret>(
  {
    integrationId: {
      type: Schema.Types.ObjectId,
      ref: 'Integration',
      required: true,
      unique: true,
    },
    provider: { type: String, required: true },
    ciphertext: { type: String, required: true },
    // Base64-encoded 96-bit AES-GCM nonce and authentication tag.
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    keyId: { type: String, required: true },
  },
  { timestamps: true, collection: 'connector_secrets' },
);

ConnectorSecretSchema.index({ integrationId: 1 }, { unique: true });

const ConnectorSecret: Model<IConnectorSecret> =
  (mongoose.models.ConnectorSecret as Model<IConnectorSecret>)
  || mongoose.model<IConnectorSecret>('ConnectorSecret', ConnectorSecretSchema);

export default ConnectorSecret;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
