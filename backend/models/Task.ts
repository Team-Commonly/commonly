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
  // ADR-018 D4: a claim is a lease, never permanent. Null on legacy claims —
  // readers derive their effective expiry from claimedAt + the route's lease.
  claimExpiresAt?: Date | null;
  // Fable's #1080 ruling, part 2: a lapsed lease held by a PROVABLY LIVE seat
  // is deferred rather than rescued, at most three times. The counter lives on
  // the row so the sweep stays stateless; it resets on every claim, so a seat
  // that renews normally never accumulates one.
  rescueDeferrals?: number;
  // Part 3: provenance always. Who held the lease when the kernel took it
  // back. Survives the rescue precisely because `claimedBy` and `assignee` do
  // not — clearing them is what makes the row findable again, and it is also
  // what erased the only record of whose work it was.
  lapsedFrom?: string | null;
  completedAt?: Date | null;
  prUrl?: string | null;
  notes?: string | null;
  source: string;
  sourceRef?: string;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  // True only when THIS server opened the issue (via `createGithubIssue`).
  // `githubIssueNumber` alone is caller-supplied and carries no provenance, so
  // it may name any issue in the repo — it is display metadata, never authority
  // to write. Only an owned issue may be auto-closed on task completion.
  githubIssueOwned?: boolean;
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
    claimExpiresAt: { type: Date, default: null },
    rescueDeferrals: { type: Number, default: 0 },
    lapsedFrom: { type: String, default: null },
    completedAt: { type: Date, default: null },
    prUrl: { type: String, default: null },
    notes: { type: String, default: null },
    source: { type: String, default: 'human' },
    sourceRef: { type: String },
    githubIssueNumber: { type: Number, default: null },
    githubIssueUrl: { type: String, default: null },
    githubIssueOwned: { type: Boolean, default: false },
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
// Partial, NOT sparse: a compound sparse index still indexes any doc where
// podId is present (i.e. all of them), so the second no-sourceRef task in a
// pod would E11000. The live DB was already repaired to this exact partial
// index (name included) — this declaration matches it so boot-time
// autoIndex neither conflicts nor recreates the broken sparse variant on
// fresh installs.
TaskSchema.index(
  { podId: 1, sourceRef: 1 },
  {
    unique: true,
    name: 'podId_1_sourceRef_1_partial',
    partialFilterExpression: { sourceRef: { $type: 'string' } },
  },
);

export const Task: Model<ITask> = mongoose.model<ITask>('Task', TaskSchema);

export default Task;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
