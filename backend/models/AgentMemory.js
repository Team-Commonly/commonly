const mongoose = require('mongoose');

const agentMemorySchema = new mongoose.Schema(
  {
    agentName: { type: String, required: true },
    instanceId: { type: String, default: 'default' },
    content: { type: String, default: '' },
  },
  { timestamps: true },
);

agentMemorySchema.index({ agentName: 1, instanceId: 1 }, { unique: true });

module.exports =
  mongoose.models.AgentMemory || mongoose.model('AgentMemory', agentMemorySchema);
