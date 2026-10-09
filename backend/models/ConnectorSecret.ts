import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * Encrypted connector credential material.
 *
 * Integration rows keep only this document's id in a ref field
 * (`config.botTokenRef`, `config.webhookUrlRef`); the material itself must never
 * be serialised through an Integration route.
 *
 * A row is identified by `(integrationId, kind)`, not by `integrationId` alone:
 * one connector can hold more than one kind, and the two-field key is what stops
 * the second `put` from overwriting the first. `kind` and the ref paths that
 * point back here are declared together in `services/connectorSecretKinds`.
 */
export interface IConnectorSecret extends Document {
  integrationId: Types.ObjectId;
  kind: string;
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
    },
    // The credential's role on the row, so a connector holding two kinds keeps
    // two secrets. Read from `services/connectorSecretKinds`; never a literal.
    kind: { type: String, required: true },
    provider: { type: String, required: true },
    ciphertext: { type: String, required: true },
    // Base64-encoded 96-bit AES-GCM nonce and authentication tag.
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    keyId: { type: String, required: true },
  },
  { timestamps: true, collection: 'connector_secrets' },
);

// One index, on the pair. `integrationId` alone was declared unique twice here
// (a field-level `unique: true` and a schema index) and `syncIndexes()` kept the
// old one by name, so adding `kind` to only one of them would have left the boot
// path enforcing the single-field key (TASK-124, wren 74127).
ConnectorSecretSchema.index({ integrationId: 1, kind: 1 }, { unique: true });

const ConnectorSecret: Model<IConnectorSecret> =
  (mongoose.models.ConnectorSecret as Model<IConnectorSecret>)
  || mongoose.model<IConnectorSecret>('ConnectorSecret', ConnectorSecretSchema);

export default ConnectorSecret;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
