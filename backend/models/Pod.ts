import mongoose, { Document, Schema, Types } from 'mongoose';

export type PodType = 'chat' | 'study' | 'games' | 'agent-ensemble' | 'agent-admin' | 'team';
export type PodJoinPolicy = 'open' | 'invite-only';
export type EnsembleParticipantRole = 'starter' | 'responder' | 'synthesizer' | 'observer';
export type HumanParticipation = 'none' | 'read-only' | 'participate';

export interface IEnsembleParticipant {
  agentType: string;
  instanceId: string;
  role: EnsembleParticipantRole;
}

export interface IPod extends Document {
  name: string;
  description?: string;
  type: PodType;
  joinPolicy: PodJoinPolicy;
  parentPod?: Types.ObjectId | null;
  agentEnsemble: {
    enabled: boolean;
    topic?: string;
    participants: IEnsembleParticipant[];
    stopConditions: {
      maxMessages: number;
      maxRounds: number;
      maxDurationMinutes: number;
    };
    schedule: {
      enabled: boolean;
      frequencyMinutes: number;
      timezone: string;
    };
    humanParticipation: HumanParticipation;
  };
  createdBy: Types.ObjectId;
  members: Types.ObjectId[];
  messages: Types.ObjectId[];
  announcements: Types.ObjectId[];
  externalLinks: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const PodSchema = new Schema<IPod>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: {
      type: String,
      enum: ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin', 'team'],
      default: 'chat',
    },
    joinPolicy: {
      type: String,
      enum: ['open', 'invite-only'],
      default: 'open',
    },
    parentPod: { type: Schema.Types.ObjectId, ref: 'Pod', default: null },
    agentEnsemble: {
      enabled: { type: Boolean, default: false },
      topic: String,
      participants: [
        {
          agentType: { type: String, required: true },
          instanceId: { type: String, default: 'default' },
          role: {
            type: String,
            enum: ['starter', 'responder', 'synthesizer', 'observer'],
            default: 'responder',
          },
        },
      ],
      stopConditions: {
        maxMessages: { type: Number, default: 20 },
        maxRounds: { type: Number, default: 5 },
        maxDurationMinutes: { type: Number, default: 60 },
      },
      schedule: {
        enabled: { type: Boolean, default: false },
        frequencyMinutes: { type: Number, default: 20 },
        timezone: { type: String, default: 'UTC' },
      },
      humanParticipation: {
        type: String,
        enum: ['none', 'read-only', 'participate'],
        default: 'participate',
      },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    messages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    announcements: [{ type: Schema.Types.ObjectId, ref: 'Announcement' }],
    externalLinks: [{ type: Schema.Types.ObjectId, ref: 'ExternalLink' }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

PodSchema.pre<IPod>('save', function (next) {
  if (this.isNew && !this.members.includes(this.createdBy)) {
    this.members.push(this.createdBy);
  }
  next();
});

export default mongoose.model<IPod>('Pod', PodSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
