const mongoose = require('mongoose');

const summarySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['posts', 'chats'],
    required: true,
  },
  podId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Pod',
    required: false, // Made optional - individual chat summaries will have podId, overall chat summaries won't
  },
  title: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timeRange: {
    start: { type: Date, required: true },
    end: { type: Date, required: true },
  },
  metadata: {
    totalItems: { type: Number, default: 0 },
    topTags: [{ type: String }],
    topUsers: [{ type: String }],
    podName: { type: String }, // For chat summaries
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for efficient querying
summarySchema.index({ type: 1, createdAt: -1 });
summarySchema.index({ type: 1, podId: 1, createdAt: -1 });
summarySchema.index({ 'timeRange.start': 1, 'timeRange.end': 1 });

module.exports = mongoose.model('Summary', summarySchema);
