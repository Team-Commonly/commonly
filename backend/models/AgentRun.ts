import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * AgentRun — per-invocation record for a native-runtime agent turn loop.
 *
 * One AgentRun row is created each time `nativeRuntimeService.runAgent()` is
 * fired for an installation. It records the trigger, every LLM turn (prompt /
 * completion tokens, tool calls, elapsed time), and the final terminal state.
 *
 * Kept intentionally minimal for the Round 1 MVP — no cost/budget fields, no
 * span tree, no resume-after-restart bookkeeping. Status + errorKind are enough
 * to explain "why did this run stop" in the UI we ship later.
 */

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

export type AgentRunTrigger =
  | 'mention'
  | 'heartbeat'
  | 'task.assigned'
  | 'chat.message'
  | 'pod.join'
  | 'manual';

export type AgentRunErrorKind =
  | 'turn_cap'
  | 'token_cap'
  | 'timeout'
  | 'tool_error'
  | 'llm_error'
  | 'config'
  | 'unknown';

export interface IAgentRunTurnToolCall {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  elapsedMs: number;
}

export interface IAgentRunTurn {
  turnIndex: number;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls: IAgentRunTurnToolCall[];
  llmResponseText?: string;
  elapsedMs: number;
  liteLLMCallId?: string;
}

export interface IAgentRun extends Document {
  podId: Types.ObjectId;
  agentName: string;
  instanceId: string;
  trigger: AgentRunTrigger;
  triggerEventId?: Types.ObjectId;
  status: AgentRunStatus;
  turns: IAgentRunTurn[];
  totalTokens: number;
  startedAt: Date;
  completedAt?: Date;
  errorKind?: AgentRunErrorKind;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AgentRunTurnToolCallSchema = new Schema<IAgentRunTurnToolCall>(
  {
    name: { type: String, required: true },
    args: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    elapsedMs: { type: Number, default: 0 },
  },
  { _id: false },
);

const AgentRunTurnSchema = new Schema<IAgentRunTurn>(
  {
    turnIndex: { type: Number, required: true },
    model: { type: String, required: true },
    promptTokens: { type: Number },
    completionTokens: { type: Number },
    totalTokens: { type: Number },
    toolCalls: { type: [AgentRunTurnToolCallSchema], default: [] },
    llmResponseText: { type: String },
    elapsedMs: { type: Number, default: 0 },
    liteLLMCallId: { type: String },
  },
  { _id: false },
);

const AgentRunSchema = new Schema<IAgentRun>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    agentName: { type: String, required: true, lowercase: true, trim: true },
    instanceId: { type: String, default: 'default' },
    trigger: {
      type: String,
      enum: ['mention', 'heartbeat', 'task.assigned', 'chat.message', 'pod.join', 'manual'],
      required: true,
    },
    triggerEventId: { type: Schema.Types.ObjectId, ref: 'AgentEvent' },
    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed', 'interrupted'],
      default: 'queued',
    },
    turns: { type: [AgentRunTurnSchema], default: [] },
    totalTokens: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    errorKind: {
      type: String,
      enum: ['turn_cap', 'token_cap', 'timeout', 'tool_error', 'llm_error', 'config', 'unknown'],
    },
    errorMessage: { type: String },
  },
  { timestamps: true },
);

AgentRunSchema.index({ podId: 1, agentName: 1, instanceId: 1, startedAt: -1 });
AgentRunSchema.index({ status: 1, startedAt: -1 });

const AgentRun: Model<IAgentRun> =
  (mongoose.models.AgentRun as Model<IAgentRun>) ||
  mongoose.model<IAgentRun>('AgentRun', AgentRunSchema);

export default AgentRun;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
