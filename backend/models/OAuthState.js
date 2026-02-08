const mongoose = require('mongoose');

const OAuthStateSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      enum: ['x'],
      index: true,
    },
    state: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    codeVerifier: {
      type: String,
      required: true,
    },
    redirectPath: {
      type: String,
      default: '/admin/integrations/global',
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
    usedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'oauth_states',
  },
);

module.exports = mongoose.model('OAuthState', OAuthStateSchema);
