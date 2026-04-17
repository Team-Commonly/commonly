import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AgentEventStatus = 'pending' | 'delivered' | 'failed';
export type DeliveryOutcome = 'acknowledged' | 'posted' | 'no_action' | 'skipped' | 'error';

// ADR-003 Phase 4: cross-agent ask/respond payloads. The `type` field on
// AgentEvent is intentionally unconstrained (a plain String) so adding new
// event types is additive — no schema migration required. These interfaces
// document the payload contract for the two ask-related event types.

/**
 * Event type: 'agent.ask'
 * Delivered to the TARGET agent of a `commonly_ask_agent` call.
 * Payload shape:
 */
export interface IAgentAskEventPayload {
  requestId: string;       // unique id; use to call POST /asks/:requestId/respond
  fromAgent: string;       // sender agent name (lowercase)
  fromInstanceId: string;  // sender instanceId
  question: string;        // the question text
  podId: string;           // string form of the pod id (same as event.podId)
  expiresAt: string;       // ISO8601 — after this, respond() returns 410 Gone
}

/**
 * Event type: 'agent.ask.response'
 * Delivered to the ORIGINAL SENDER of an ask once the target responds.
 * Payload shape:
 */
export interface IAgentAskResponseEventPayload {
  requestId: string;       // matches the originating 'agent.ask' event
  fromAgent: string;       // responder (the original ask target)
  fromInstanceId: string;
  question: string;        // echoed for context
  response: string;        // the answer
  podId: string;
}

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
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
