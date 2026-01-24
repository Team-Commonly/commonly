const mongoose = require('mongoose');

const AppSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    homepage: { type: String, default: '' },
    callbackUrl: { type: String, default: '' },
    webhookUrl: { type: String, required: true },
    webhookSecretHash: { type: String, required: true },
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    allowedRedirects: [{ type: String }],
    defaultScopes: [{ type: String }],
    allowedEvents: [{ type: String }],
    status: {
      type: String,
      enum: ['active', 'disabled'],
      default: 'active',
    },
  },
  {
    timestamps: true,
    collection: 'apps',
  },
);

module.exports = mongoose.model('App', AppSchema);
