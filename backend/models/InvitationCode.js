const mongoose = require('mongoose');

const invitationCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  note: {
    type: String,
    trim: true,
    default: '',
  },
  maxUses: {
    type: Number,
    default: 1,
    min: 1,
  },
  useCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  expiresAt: {
    type: Date,
    default: null,
  },
  lastUsedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

invitationCodeSchema.index({ isActive: 1, expiresAt: 1 });

module.exports = mongoose.model('InvitationCode', invitationCodeSchema);
