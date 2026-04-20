import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'blocked';
export type TaskUpdateKind = 'note' | 'progress' | 'blocker' | 'handoff' | 'decision' | 'completion';

export interface ITaskUpdate {
  text: string;
  author: string;
  authorId?: string | null;
  kind?: TaskUpdateKind;
  progressPercent?: number | null;
  nextStep?: string | null;
  createdAt: Date;
}

export interface ITask extends Document {
  podId: Types.ObjectId;
  taskNum: number;
  taskId: string;
  title: string;
  description?: string | null;
  assignee?: string | null;
  assigneeType?: 'human' | 'agent' | null;
  assigneeRef?: string | null;
  dep?: string | null;
  depMockOk: boolean;
  parentTask?: string | null;
  status: TaskStatus;
  priority?: 'low' | 'medium' | 'high' | null;
  dueDate?: Date | null;
  progressPercent?: number | null;
  claimedBy?: string | null;
  claimedAt?: Date | null;
  completedAt?: Date | null;
  prUrl?: string | null;
  notes?: string | null;
  source: string;
  sourceRef?: string;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  blocker?: {
    open: boolean;
    reason?: string | null;
    waitingOn?: string | null;
    severity?: 'low' | 'medium' | 'high' | null;
    openedAt?: Date | null;
    openedBy?: string | null;
    resolvedAt?: Date | null;
  };
  updates: ITaskUpdate[];
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<ITask>(
  {
    podId: { type: Schema.Types.ObjectId, required: true, ref: 'Pod' },
    taskNum: { type: Number, required: true },
    taskId: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: null },
    assignee: { type: String, default: null },
    assigneeType: { type: String, enum: ['human', 'agent'], default: null },
    assigneeRef: { type: String, default: null },
    dep: { type: String, default: null },
    depMockOk: { type: Boolean, default: false },
    parentTask: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'claimed', 'done', 'blocked'],
      default: 'pending',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    dueDate: { type: Date, default: null },
    progressPercent: { type: Number, default: 0, min: 0, max: 100 },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    prUrl: { type: String, default: null },
    notes: { type: String, default: null },
    source: { type: String, default: 'human' },
    sourceRef: { type: String },
    githubIssueNumber: { type: Number, default: null },
    githubIssueUrl: { type: String, default: null },
    blocker: {
      open: { type: Boolean, default: false },
      reason: { type: String, default: null },
      waitingOn: { type: String, default: null },
      severity: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'medium',
      },
      openedAt: { type: Date, default: null },
      openedBy: { type: String, default: null },
      resolvedAt: { type: Date, default: null },
    },
    updates: [
      {
        text: { type: String, required: true },
        author: { type: String, required: true },
        authorId: { type: String, default: null },
        kind: {
          type: String,
          enum: ['note', 'progress', 'blocker', 'handoff', 'decision', 'completion'],
          default: 'note',
        },
        progressPercent: { type: Number, default: null, min: 0, max: 100 },
        nextStep: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

TaskSchema.index({ podId: 1, status: 1 });
TaskSchema.index({ podId: 1, assignee: 1, status: 1 });
TaskSchema.index({ podId: 1, taskId: 1 }, { unique: true });
TaskSchema.index({ podId: 1, sourceRef: 1 }, { unique: true, sparse: true });

export const Task: Model<ITask> = mongoose.model<ITask>('Task', TaskSchema);

export default Task;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
