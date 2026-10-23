import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * One vendor-issued OAuth client for an instance and catalogue entry: public
 * (`token_endpoint_auth_method: 'none'`) when the vendor offers that, otherwise
 * confidential, with its secret kept encrypted in the connector-secret store
 * and owned by this row (TASK-248).
 */
export interface IHostedMcpDcrRegistration extends Document {
  entryId: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** How this client authenticates at the token and revocation endpoints. */
  tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post';
  /** connectorSecrets ref of the client secret; set only for a confidential client. */
  clientSecretRef?: string | null;
  /** When the vendor said the secret lapses; null means it never does. */
  clientSecretExpiresAt?: Date | null;
  current: boolean;
  retiredAt?: Date | null;
  refusedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const HostedMcpDcrRegistrationSchema = new Schema<IHostedMcpDcrRegistration>({
  entryId: { type: String, required: true },
  issuer: { type: String, required: true },
  clientId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  tokenEndpointAuthMethod: {
    type: String, enum: ['none', 'client_secret_basic', 'client_secret_post'], default: 'none',
  },
  clientSecretRef: { type: String, default: null },
  clientSecretExpiresAt: { type: Date, default: null },
  current: { type: Boolean, required: true },
  retiredAt: { type: Date, default: null },
  refusedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'hosted_mcp_dcr_registrations' });

// Retired clients remain addressable by the rows they minted. Only one client
// may receive NEW authorizations for an entry and issuer at a time.
HostedMcpDcrRegistrationSchema.index(
  { entryId: 1, issuer: 1 },
  { unique: true, partialFilterExpression: { current: true } },
);
HostedMcpDcrRegistrationSchema.index(
  { entryId: 1, issuer: 1, clientId: 1 },
  { unique: true },
);

const HostedMcpDcrRegistration: Model<IHostedMcpDcrRegistration> =
  (mongoose.models.HostedMcpDcrRegistration as Model<IHostedMcpDcrRegistration>)
  || mongoose.model<IHostedMcpDcrRegistration>('HostedMcpDcrRegistration', HostedMcpDcrRegistrationSchema);

export default HostedMcpDcrRegistration;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
