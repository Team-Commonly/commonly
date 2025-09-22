const mongoose = require('mongoose');

const ExternalLinkSchema = new mongoose.Schema(
  {
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['discord', 'telegram', 'wechat', 'groupme', 'other'],
      default: 'other',
    },
    url: {
      type: String,
      trim: true,
    },
    qrCodePath: {
      type: String,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

// Validate that either URL or QR code path is provided
ExternalLinkSchema.pre('save', function (next) {
  if (this.type === 'wechat' && !this.qrCodePath && !this.url) {
    return next(new Error('WeChat links require either a QR code or URL'));
  }

  if (this.type !== 'wechat' && !this.url) {
    return next(new Error('URL is required for non-WeChat links'));
  }

  next();
});

module.exports = mongoose.model('ExternalLink', ExternalLinkSchema);
