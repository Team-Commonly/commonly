const mongoose = require('mongoose');

const AgentEventSchema = new mongoose.Schema(
  {
    agentName: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    instanceId: {
      type: String,
      default: 'default',
    },
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
    },
    payload: mongoose.Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['pending', 'delivered', 'failed'],
      default: 'pending',
    },
    attempts: {
      type: Number,
      default: 0,
    },
    deliveredAt: Date,
    error: String,
  },
  {
    timestamps: true,
  },
);

AgentEventSchema.index({ agentName: 1, instanceId: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model('AgentEvent', AgentEventSchema);
