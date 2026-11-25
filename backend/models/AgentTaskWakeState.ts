import mongoose, { Document, Schema } from 'mongoose';
import { dualStorePlugin } from '../repositories/dualStore';

interface IAgentTaskWakeState extends Document {
  _id: string;
  lastWakeAt: Date;
}

// One durable throttle for an identity across all its pod projections. The
// primary key also serializes two schedulers without waiting for index builds.
const schema = new Schema<IAgentTaskWakeState>({
  _id: { type: String, required: true },
  lastWakeAt: { type: Date, required: true },
}, { timestamps: true });
// ADR-034 step 2: the repair markers (pgVersion, pgPending, pgDeleted) and their sparse index.
dualStorePlugin(schema);

const AgentTaskWakeState = mongoose.model<IAgentTaskWakeState>('AgentTaskWakeState', schema);
export default AgentTaskWakeState;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = AgentTaskWakeState;
