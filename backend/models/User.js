const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    profilePicture: { type: String, default: '' },
    bio: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) next();
    this.password = await bcrypt.hash(this.password, 10);
});

module.exports = mongoose.model('User', userSchema);
