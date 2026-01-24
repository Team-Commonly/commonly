const mongoose = require('mongoose');

const AppInstallationSchema = new mongoose.Schema(
  {
    appId: { type: mongoose.Schema.Types.ObjectId, ref: 'App', required: true },
    targetType: { type: String, enum: ['pod', 'user'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    scopes: [{ type: String }],
    events: [{ type: String }],
    tokenHash: { type: String, required: true },
    tokenExpiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  },
  {
    timestamps: true,
    collection: 'app_installations',
  },
);

module.exports = mongoose.model('AppInstallation', AppInstallationSchema);
