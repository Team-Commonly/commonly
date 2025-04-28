const mongoose = require('mongoose');

const { Schema } = mongoose;

const MessageSchema = new Schema({
  podId: {
    type: Schema.Types.ObjectId,
    ref: 'Pod',
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  messageType: {
    type: String,
    enum: ['text', 'image'],
    default: 'text',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Message', MessageSchema);
