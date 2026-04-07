import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AgentEventStatus = 'pending' | 'delivered' | 'failed';
export type DeliveryOutcome = 'acknowledged' | 'posted' | 'no_action' | 'skipped' | 'error';

export interface IAgentEventDelivery {
  outcome?: DeliveryOutcome;
  reason?: string;
  messageId?: string;
  details?: unknown;
  updatedAt?: Date;
}

export interface IAgentEvent extends Document {
  agentName: string;
  instanceId: string;
  podId: Types.ObjectId;
  type: string;
  payload?: unknown;
  status: AgentEventStatus;
  attempts: number;
  deliveredAt?: Date;
  error?: string;
  delivery?: IAgentEventDelivery;
  createdAt: Date;
  updatedAt: Date;
}

const AgentEventSchema = new Schema<IAgentEvent>(
  {
    agentName: { type: String, required: true, lowercase: true, trim: true },
    instanceId: { type: String, default: 'default' },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true, index: true },
    type: { type: String, required: true },
    payload: Schema.Types.Mixed,
    status: { type: String, enum: ['pending', 'delivered', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    deliveredAt: Date,
    error: String,
    delivery: {
      outcome: {
        type: String,
        enum: ['acknowledged', 'posted', 'no_action', 'skipped', 'error'],
      },
      reason: String,
      messageId: String,
      details: Schema.Types.Mixed,
      updatedAt: Date,
    },
  },
  { timestamps: true },
);

AgentEventSchema.index({ agentName: 1, instanceId: 1, status: 1, createdAt: 1 });

export const AgentEvent: Model<IAgentEvent> = mongoose.model<IAgentEvent>(
  'AgentEvent',
  AgentEventSchema,
);

export default AgentEvent;
