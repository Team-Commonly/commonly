const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const Pod = require('../models/Pod');
const User = require('../models/User');

// Load environment variables
dotenv.config();

// MongoDB URI
const mongoURI = process.env.MONGO_URI || 'mongodb://mongodb:27017/commonly';

const seedPods = async () => {
  try {
    await mongoose.connect(mongoURI);
    // Find a user or create one if none exists
    let user = await User.findOne();

    if (!user) {
      console.log('No users found. Creating a test user...');

      // Create a test user
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('password123', salt);

      user = new User({
        username: 'testuser',
        email: 'test@example.com',
        password: hashedPassword,
        verified: true,
      });

      await user.save();
      console.log('Test user created successfully');
    }

    // Delete existing pods
    await Pod.deleteMany({});

    // Create sample pods
    const pods = [
      {
        name: 'General Chat',
        description: 'A place to discuss anything and everything',
        type: 'chat',
        createdBy: user._id,
        members: [user._id],
      },
      {
        name: 'Tech Talk',
        description: 'Discuss the latest in technology',
        type: 'chat',
        createdBy: user._id,
        members: [user._id],
      },
      {
        name: 'Study Group',
        description: 'A quiet place to study together',
        type: 'study',
        createdBy: user._id,
        members: [user._id],
      },
      {
        name: 'Math Help',
        description: 'Get help with math problems',
        type: 'study',
        createdBy: user._id,
        members: [user._id],
      },
      {
        name: 'Chess Club',
        description: 'Play and discuss chess',
        type: 'games',
        createdBy: user._id,
        members: [user._id],
      },
      {
        name: 'Trivia Night',
        description: 'Test your knowledge with trivia',
        type: 'games',
        createdBy: user._id,
        members: [user._id],
      },
    ];

    await Pod.insertMany(pods);

    console.log('Pods seeded successfully');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err: unknown) {
    console.error('Error seeding pods:', err);
    await mongoose.disconnect();
    process.exit(1);
  }
};

if (require.main === module) {
  seedPods();
}

module.exports = seedPods;
export {};
