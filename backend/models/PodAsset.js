const mongoose = require('mongoose');

const { Schema } = mongoose;

const PodAssetSchema = new Schema(
  {
    podId: {
      type: Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'summary',
        'integration-summary',
        'skill',
        'memory',
        'daily-log',
        'message',
        'thread',
        'file',
        'doc',
        'link',
      ],
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      default: '',
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    sourceType: {
      type: String,
      default: null,
    },
    sourceRef: {
      summaryId: {
        type: Schema.Types.ObjectId,
        ref: 'Summary',
        default: null,
      },
      integrationId: {
        type: Schema.Types.ObjectId,
        ref: 'Integration',
        default: null,
      },
      messageId: {
        type: String,
        default: null,
      },
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdByType: {
      type: String,
      enum: ['system', 'user', 'agent'],
      default: 'system',
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true },
);

PodAssetSchema.index({ podId: 1, createdAt: -1 });
PodAssetSchema.index({ podId: 1, tags: 1, createdAt: -1 });
PodAssetSchema.index(
  { title: 'text', content: 'text', tags: 'text' },
  { weights: { title: 5, tags: 4, content: 1 } },
);

module.exports = mongoose.model('PodAsset', PodAssetSchema);
