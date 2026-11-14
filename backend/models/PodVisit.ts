import mongoose, { Document, Model, Schema, Types } from 'mongoose';

// When a person last opened a pod and last left it (F512). The mention email
// reads it to tell "saw it" from "hasn't been back": a message fetch or a
// socket join stamps openedAt, a socket leave or disconnect stamps closedAt.
// openedAt later than closedAt means the pod is open now.
export interface IPodVisit extends Document {
  userId: Types.ObjectId;
  podId: Types.ObjectId;
  openedAt?: Date;
  closedAt?: Date;
}

const schema = new Schema<IPodVisit>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  openedAt: { type: Date },
  closedAt: { type: Date },
});

schema.index({ userId: 1, podId: 1 }, { unique: true });

const PodVisit: Model<IPodVisit> = mongoose.models.PodVisit
  || mongoose.model<IPodVisit>('PodVisit', schema);

export default PodVisit;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = PodVisit;
