const mongoose = require('mongoose');

const GatewaySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    type: { type: String, enum: ['openclaw'], default: 'openclaw' },
    mode: { type: String, enum: ['local', 'remote', 'k8s'], default: 'local' },
    baseUrl: { type: String, default: '' },
    configPath: { type: String, default: '' },
    status: { type: String, enum: ['active', 'paused', 'disabled'], default: 'active' },
    metadata: { type: mongoose.Schema.Types.Mixed },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

GatewaySchema.index({ slug: 1 }, { unique: true });

module.exports = mongoose.model('Gateway', GatewaySchema);
