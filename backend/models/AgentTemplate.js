const mongoose = require('mongoose');

const AgentTemplateSchema = new mongoose.Schema(
  {
    agentName: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    iconUrl: {
      type: String,
      default: '',
      trim: true,
    },
    visibility: {
      type: String,
      enum: ['private', 'public'],
      default: 'private',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

AgentTemplateSchema.index({ agentName: 1, visibility: 1 });
AgentTemplateSchema.index({ createdBy: 1, visibility: 1 });

module.exports = mongoose.model('AgentTemplate', AgentTemplateSchema);
