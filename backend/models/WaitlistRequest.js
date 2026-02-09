const mongoose = require('mongoose');

const waitlistRequestSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  name: {
    type: String,
    trim: true,
    default: '',
  },
  organization: {
    type: String,
    trim: true,
    default: '',
  },
  useCase: {
    type: String,
    trim: true,
    default: '',
  },
  note: {
    type: String,
    trim: true,
    default: '',
  },
  status: {
    type: String,
    enum: ['pending', 'invited', 'closed'],
    default: 'pending',
    index: true,
  },
  invitationCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InvitationCode',
    default: null,
  },
  invitedAt: {
    type: Date,
    default: null,
  },
  invitationSentAt: {
    type: Date,
    default: null,
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, {
  timestamps: true,
});

waitlistRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WaitlistRequest', waitlistRequestSchema);
