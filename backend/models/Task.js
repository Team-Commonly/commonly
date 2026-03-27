const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema(
  {
    podId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Pod' },
    taskNum: { type: Number, required: true },
    taskId: { type: String, required: true }, // "TASK-001"
    title: { type: String, required: true },
    assignee: { type: String, default: null }, // agent instanceId or null
    dep: { type: String, default: null }, // "TASK-001" or null — blocking dependency
    depMockOk: { type: Boolean, default: false }, // true = can start with mocks even if dep unmet
    status: {
      type: String,
      enum: ['pending', 'claimed', 'done', 'blocked'],
      default: 'pending',
    },
    claimedBy: { type: String, default: null }, // instanceId of claiming agent
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    prUrl: { type: String, default: null },
    notes: { type: String, default: null },
    source: { type: String, default: 'human' }, // 'github' | 'human' | 'agent'
    sourceRef: { type: String, default: null }, // e.g. 'GH#1'
    githubIssueNumber: { type: Number, default: null }, // linked GH issue number for auto-close
    githubIssueUrl: { type: String, default: null }, // e.g. https://github.com/Team-Commonly/commonly/issues/1
    updates: [
      {
        text: { type: String, required: true },
        author: { type: String, required: true }, // username or agent instanceId
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
// Prevent duplicate tasks for the same GitHub issue in a pod
TaskSchema.index({ podId: 1, sourceRef: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Task', TaskSchema);
