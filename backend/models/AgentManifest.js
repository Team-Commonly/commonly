const mongoose = require('mongoose');

const AgentManifestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    version: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    author: { type: String, required: true, trim: true },
    runtimeType: {
      type: String,
      required: true,
      enum: ['webhook', 'moltbot', 'internal'],
    },
    webhookUrl: { type: String, default: '', trim: true },
    capabilities: [{ type: String, trim: true }],
    iconUrl: { type: String, default: '', trim: true },
    isPublic: { type: Boolean, default: false },
    installedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

AgentManifestSchema.index({ slug: 1 }, { unique: true });

module.exports = mongoose.model('AgentManifest', AgentManifestSchema);
