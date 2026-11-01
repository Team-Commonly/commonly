import mongoose, { Document, Schema, Types } from 'mongoose';

interface IAgentTaskRowWakeState extends Document {
  _id: string;
  lastWakeAt: Date | null;
  lastWakeEventId: Types.ObjectId | null;
  // The wake event whose outcome is already in `failures`, so one run counts once.
  countedEventId: Types.ObjectId | null;
  failures: number;
  stoppedAt: Date | null;
  // How the counted run ended. 'succeeded' means a run saw the row as it stood.
  lastVerdict: 'succeeded' | 'failed' | 'neutral' | null;
}

// What the assigned-task wake remembers about one row for one seat, keyed
// `<seat key>|<row _id>`. AgentTaskWakeState throttles the seat; this decides
// whether a row may wake it at all: a row the agent wrote for itself wakes it
// once per human action, any other row wakes it again after a completed run
// only for an update someone else made, and any row stops after repeated
// failed runs.
const schema = new Schema<IAgentTaskRowWakeState>({
  _id: { type: String, required: true },
  lastWakeAt: { type: Date, default: null },
  lastWakeEventId: { type: Schema.Types.ObjectId, default: null },
  countedEventId: { type: Schema.Types.ObjectId, default: null },
  failures: { type: Number, default: 0 },
  stoppedAt: { type: Date, default: null },
  lastVerdict: { type: String, enum: ['succeeded', 'failed', 'neutral', null], default: null },
}, { timestamps: true });

const AgentTaskRowWakeState = mongoose.model<IAgentTaskRowWakeState>('AgentTaskRowWakeState', schema);
export default AgentTaskRowWakeState;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = AgentTaskRowWakeState;
