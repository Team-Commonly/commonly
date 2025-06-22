const mongoose = require('mongoose');

const IntegrationSchema = new mongoose.Schema({
  podId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Pod',
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: ['discord', 'telegram', 'slack', 'messenger'],
    default: 'discord',
  },
  status: {
    type: String,
    required: true,
    enum: ['connected', 'disconnected', 'error', 'pending'],
    default: 'pending',
  },
  config: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  lastSync: {
    type: Date,
    default: null,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  errorMessage: {
    type: String,
    default: null,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
  collection: 'integrations',
});

// Index for efficient queries
IntegrationSchema.index({ podId: 1, type: 1 });
IntegrationSchema.index({ status: 1 });
IntegrationSchema.index({ createdBy: 1 });

// Virtual for platform-specific integration
IntegrationSchema.virtual('platformIntegration', {
  refPath: 'type',
  localField: '_id',
  foreignField: 'integrationId',
  justOne: true,
});

// Ensure virtuals are serialized
IntegrationSchema.set('toJSON', { virtuals: true });
IntegrationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Integration', IntegrationSchema);
