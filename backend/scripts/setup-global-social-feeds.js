/**
 * Setup Global Social Feeds for Launch
 *
 * Creates Integration records for Commonly's official X and Instagram accounts
 * so that all curator agents can access pre-seeded social content.
 *
 * Usage:
 *   node backend/scripts/setup-global-social-feeds.js
 *
 * Environment Variables Required:
 *   - X_GLOBAL_ACCESS_TOKEN
 *   - X_GLOBAL_USERNAME (e.g., "CommonlyHQ")
 *   - X_GLOBAL_USER_ID
 *   - INSTAGRAM_GLOBAL_ACCESS_TOKEN
 *   - INSTAGRAM_GLOBAL_IG_USER_ID
 *   - INSTAGRAM_GLOBAL_USERNAME (e.g., "commonly.app")
 *   - ADMIN_USER_EMAIL (email of admin user)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Integration = require('../models/Integration');
const Pod = require('../models/Pod');
const User = require('../models/User');

async function setupGlobalSocialFeeds() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // 1. Find or create admin user
    const adminEmail = process.env.ADMIN_USER_EMAIL || 'admin@commonly.app';
    let adminUser = await User.findOne({ email: adminEmail });

    if (!adminUser) {
      console.error('❌ Admin user not found. Please set ADMIN_USER_EMAIL environment variable.');
      process.exit(1);
    }
    console.log(`✅ Found admin user: ${adminUser.username}`);

    // 2. Find or create global pod for social feeds
    let globalPod = await Pod.findOne({ name: 'Global Social Feed' });

    if (!globalPod) {
      globalPod = await Pod.create({
        name: 'Global Social Feed',
        description: 'Commonly\'s curated social media feeds from X and Instagram',
        type: 'chat',
        members: [adminUser._id],
        createdBy: adminUser._id,
        tags: ['social', 'global', 'feeds']
      });
      console.log('✅ Created global pod for social feeds');
    } else {
      console.log('✅ Found existing global pod');
    }

    // 3. Setup X (Twitter) Integration
    if (process.env.X_GLOBAL_ACCESS_TOKEN) {
      // Check if integration already exists
      let xIntegration = await Integration.findOne({
        type: 'x',
        podId: globalPod._id
      });

      if (xIntegration) {
        console.log('⚠️  X integration already exists, updating...');
        xIntegration.config = {
          ...xIntegration.config,
          accessToken: process.env.X_GLOBAL_ACCESS_TOKEN,
          username: process.env.X_GLOBAL_USERNAME || 'CommonlyHQ',
          userId: process.env.X_GLOBAL_USER_ID,
          category: 'Social',
          maxResults: 50,
          exclude: 'retweets,replies'
        };
        xIntegration.status = 'connected';
        await xIntegration.save();
      } else {
        xIntegration = await Integration.create({
          podId: globalPod._id,
          type: 'x',
          status: 'connected',
          config: {
            accessToken: process.env.X_GLOBAL_ACCESS_TOKEN,
            username: process.env.X_GLOBAL_USERNAME || 'CommonlyHQ',
            userId: process.env.X_GLOBAL_USER_ID,
            category: 'Social',
            maxResults: 50,
            exclude: 'retweets,replies',
            apiBase: process.env.X_API_BASE_URL || 'https://api.x.com/2'
          },
          createdBy: adminUser._id
        });
        console.log('✅ Created X integration');
      }
      console.log(`   Username: @${xIntegration.config.username}`);
    } else {
      console.log('⚠️  X_GLOBAL_ACCESS_TOKEN not set, skipping X integration');
    }

    // 4. Setup Instagram Integration
    if (process.env.INSTAGRAM_GLOBAL_ACCESS_TOKEN) {
      // Check if integration already exists
      let instagramIntegration = await Integration.findOne({
        type: 'instagram',
        podId: globalPod._id
      });

      if (instagramIntegration) {
        console.log('⚠️  Instagram integration already exists, updating...');
        instagramIntegration.config = {
          ...instagramIntegration.config,
          accessToken: process.env.INSTAGRAM_GLOBAL_ACCESS_TOKEN,
          igUserId: process.env.INSTAGRAM_GLOBAL_IG_USER_ID,
          username: process.env.INSTAGRAM_GLOBAL_USERNAME || 'commonly.app',
          category: 'Social'
        };
        instagramIntegration.status = 'connected';
        await instagramIntegration.save();
      } else {
        instagramIntegration = await Integration.create({
          podId: globalPod._id,
          type: 'instagram',
          status: 'connected',
          config: {
            accessToken: process.env.INSTAGRAM_GLOBAL_ACCESS_TOKEN,
            igUserId: process.env.INSTAGRAM_GLOBAL_IG_USER_ID,
            username: process.env.INSTAGRAM_GLOBAL_USERNAME || 'commonly.app',
            category: 'Social',
            apiBase: process.env.INSTAGRAM_GRAPH_API_BASE || 'https://graph.facebook.com/v19.0'
          },
          createdBy: adminUser._id
        });
        console.log('✅ Created Instagram integration');
      }
      console.log(`   Username: @${instagramIntegration.config.username}`);
    } else {
      console.log('⚠️  INSTAGRAM_GLOBAL_ACCESS_TOKEN not set, skipping Instagram integration');
    }

    // 5. Summary
    console.log('\n✅ Global social feeds setup complete!');
    console.log('\nNext steps:');
    console.log('1. Background polling service will fetch posts every 10 minutes');
    console.log('2. Posts will be available at: GET /api/posts?category=Social');
    console.log('3. Deploy curator agents to themed pods');
    console.log('4. Agents will automatically curate content from these feeds');

    await mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error setting up global social feeds:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  setupGlobalSocialFeeds();
}

module.exports = { setupGlobalSocialFeeds };
