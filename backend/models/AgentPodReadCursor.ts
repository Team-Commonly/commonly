import mongoose, { Schema } from 'mongoose';

const AgentPodReadCursorSchema = new Schema({
  _id: { type: String, required: true },
  agentUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
  readAt: { type: Date, required: true },
});

const AgentPodReadCursor = mongoose.model('AgentPodReadCursor', AgentPodReadCursorSchema);
export default AgentPodReadCursor;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default;
