const mongoose = require('mongoose');

const PodSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    type: {
        type: String,
        enum: ['public', 'private', 'chat'],
        default: 'public'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    messages: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    }],
    announcements: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Announcement'
    }],
    externalLinks: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ExternalLink'
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Add the creator to members automatically
PodSchema.pre('save', function(next) {
    if (this.isNew && !this.members.includes(this.createdBy)) {
        this.members.push(this.createdBy);
    }
    next();
});

module.exports = mongoose.model('Pod', PodSchema); 