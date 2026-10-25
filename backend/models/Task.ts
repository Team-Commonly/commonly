import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'blocked';

export interface ITaskUpdate {
  text: string;
  author: string;
  authorId?: string | null;
  createdAt: Date;
}

export interface ITaskRuling {
  state: 'awaiting' | 'approved' | 'declined';
  approvalId: Types.ObjectId;
  decidedBy?: Types.ObjectId;
  decidedAt?: Date;
}

export interface ITask extends Document {
  podId: Types.ObjectId;
  taskNum: number;
  taskId: string;
  title: string;
  priority: TaskPriority;
  watchers: Types.ObjectId[];
  watcherDeliveryPendingAt?: Date;
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
  // The updatedAt revision most recently offered to eligible pod agents.
  offeredAt?: Date | null;
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
  ruling?: ITaskRuling;
  guard?: 'kernel' | 'person';
  // Runner-owned history; editing a procedure must not reinterpret a finished run.
  playbookSnapshot?: { definition: unknown; bindings: Record<string, string>; members: Array<{ userId: string; label?: string; handle: string; kind: string }> };
  completedBy?: string;
  completedAt?: Date | null;
  prUrl?: string | null;
  notes?: string | null;
  source: string;
  sourceRef?: string;
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
    priority: { type: String, enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
    watchers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    // Internal retry revision; never advances the public task revision.
    watcherDeliveryPendingAt: { type: Date },
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
    // No default: missing means this revision has not been offered.
    offeredAt: { type: Date },
    rescueDeferrals: { type: Number, default: 0 },
    lapsedFrom: { type: String, default: null },
    ruling: {
      type: new Schema({
        state: { type: String, enum: ['awaiting', 'approved', 'declined'], required: true },
        approvalId: { type: Schema.Types.ObjectId, ref: 'ApprovalAction', required: true },
        decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        decidedAt: Date,
      }, { _id: false }),
    },
    guard: { type: String, enum: ['kernel', 'person'] },
    playbookSnapshot: { type: Schema.Types.Mixed },
    completedBy: { type: String, ref: 'User' },
    completedAt: { type: Date, default: null },
    prUrl: { type: String, default: null },
    notes: { type: String, default: null },
    source: { type: String, default: 'human' },
    sourceRef: { type: String },
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

TaskSchema.index({ 'ruling.approvalId': 1 }, { sparse: true });
TaskSchema.index({ podId: 1, status: 1 });
TaskSchema.index({ watchers: 1, podId: 1, updatedAt: -1 });
TaskSchema.index({ watcherDeliveryPendingAt: 1, _id: 1 }, { partialFilterExpression: { watcherDeliveryPendingAt: { $type: 'date' } } });
TaskSchema.index({ podId: 1, assignee: 1, status: 1 });
TaskSchema.index(
  { podId: 1, prUrl: 1, status: 1 },
  { partialFilterExpression: { prUrl: { $type: 'string' } } },
);
TaskSchema.index({ podId: 1, taskId: 1 }, { unique: true });
// Partial, NOT sparse: a compound sparse index still indexes any doc where
// podId is present (i.e. all of them), so the second no-sourceRef task in a
// pod would E11000. The live DB was already repaired to this exact partial
// index (name included) — this declaration matches it so boot-time
// autoIndex neither conflicts nor recreates the broken sparse variant on
// fresh installs.
//
// `sourceRef` is PROVENANCE, not identity (TASK-063). One source — a message,
// a PR — can raise several asks with several owners, and keying on the ref
// alone made the second ask adopt the first ask's row: it discarded the
// caller's title and reopened that row instead, twice in production (TASK-052,
// TASK-163), the second time on a row a merged PR had legitimately completed.
// The identity of a create is therefore the (sourceRef, title) PAIR — a retry
// of the same ask stays idempotent, a different title becomes its own row.
//
// The legacy index cannot enforce that, and autoIndex CREATES the declared
// index but never DROPS an undeclared one, so an existing database keeps the
// stricter ref-only index until scripts/migrate-task-source-ref-identity.ts
// runs. Until then the route answers a second title under one ref with a named
// 503 rather than a silent wrong row.
TaskSchema.index(
  { podId: 1, sourceRef: 1, title: 1 },
  {
    unique: true,
    name: 'podId_1_sourceRef_1_title_1_partial',
    partialFilterExpression: { sourceRef: { $type: 'string' } },
  },
);

export const Task: Model<ITask> = mongoose.model<ITask>('Task', TaskSchema);

export default Task;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
