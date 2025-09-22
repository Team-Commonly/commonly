const mongoose = require('mongoose');

const AnnouncementSchema = new mongoose.Schema(
  {
    podId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pod',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Announcement', AnnouncementSchema);
