import mongoose, { Document, Model, Schema } from 'mongoose';

/** One vendor-issued public OAuth client for an instance and catalogue entry. */
export interface IHostedMcpDcrRegistration extends Document {
  entryId: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
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
