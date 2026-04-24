import mongoose, { Document, Schema, Types } from 'mongoose';

export type PodType = 'chat' | 'study' | 'games' | 'project' | 'agent-ensemble' | 'agent-admin' | 'agent-room' | 'team';
export type PodJoinPolicy = 'open' | 'invite-only';
export type EnsembleParticipantRole = 'starter' | 'responder' | 'synthesizer' | 'observer';
export type HumanParticipation = 'none' | 'read-only' | 'participate';
export type ProjectStatus = 'planning' | 'on-track' | 'at-risk' | 'blocked' | 'complete';

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
  projectMeta: {
    goal?: string;
    scope?: string;
    successCriteria: string[];
    status: ProjectStatus;
    dueDate?: Date | null;
    ownerIds: Types.ObjectId[];
    keyLinks: Array<{
      label: string;
      url: string;
    }>;
  };
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
      enum: ['chat', 'study', 'games', 'project', 'agent-ensemble', 'agent-admin', 'agent-room', 'team'],
      default: 'chat',
    },
    joinPolicy: {
      type: String,
      enum: ['open', 'invite-only'],
      default: 'open',
    },
    projectMeta: {
      goal: { type: String, trim: true, default: '' },
      scope: { type: String, trim: true, default: '' },
      successCriteria: { type: [String], default: [] },
      status: {
        type: String,
        enum: ['planning', 'on-track', 'at-risk', 'blocked', 'complete'],
        default: 'planning',
      },
      dueDate: { type: Date, default: null },
      ownerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      keyLinks: [
        {
          label: { type: String, trim: true, default: '' },
          url: { type: String, trim: true, default: '' },
        },
      ],
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
