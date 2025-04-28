const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  fileName: {
    type: String,
    required: true,
  },
  originalName: {
    type: String,
    required: true,
  },
  contentType: {
    type: String,
    required: true,
  },
  size: {
    type: Number,
    required: true,
  },
  data: {
    type: Buffer,
    required: true,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Create an index on fileName for faster lookups
fileSchema.index({ fileName: 1 });

// Static method to get a file by its fileName
fileSchema.statics.findByFileName = function (fileName) {
  return this.findOne({ fileName });
};

module.exports = mongoose.model('File', fileSchema);
