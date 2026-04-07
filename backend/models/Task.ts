import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'blocked';

export interface ITaskUpdate {
  text: string;
  author: string;
  authorId?: string | null;
  createdAt: Date;
}

export interface ITask extends Document {
  podId: Types.ObjectId;
  taskNum: number;
  taskId: string;
  title: string;
  assignee?: string | null;
  dep?: string | null;
  depMockOk: boolean;
  parentTask?: string | null;
  status: TaskStatus;
  claimedBy?: string | null;
  claimedAt?: Date | null;
  completedAt?: Date | null;
  prUrl?: string | null;
  notes?: string | null;
  source: string;
  sourceRef?: string;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
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
    assignee: { type: String, default: null },
    dep: { type: String, default: null },
    depMockOk: { type: Boolean, default: false },
    parentTask: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'claimed', 'done', 'blocked'],
      default: 'pending',
    },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    prUrl: { type: String, default: null },
    notes: { type: String, default: null },
    source: { type: String, default: 'human' },
    sourceRef: { type: String },
    githubIssueNumber: { type: Number, default: null },
    githubIssueUrl: { type: String, default: null },
    updates: [
      {
        text: { type: String, required: true },
        author: { type: String, required: true },
        authorId: { type: String, default: null },
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
