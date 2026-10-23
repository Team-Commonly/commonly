import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/** Explicit opt-in for one App installation/repository to post in one pod. */
export interface IGithubGigBinding extends Document {
  installationId: string;
  owner: string;
  repo: string;
  podId: Types.ObjectId;
  createdBy: Types.ObjectId;
}

const GithubGigBindingSchema = new Schema<IGithubGigBinding>({
  installationId: { type: String, required: true },
  owner: { type: String, required: true },
  repo: { type: String, required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

GithubGigBindingSchema.index({ installationId: 1, owner: 1, repo: 1 }, { unique: true });

export const GithubGigBinding: Model<IGithubGigBinding> = mongoose.model<IGithubGigBinding>('GithubGigBinding', GithubGigBindingSchema);
export default GithubGigBinding;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
