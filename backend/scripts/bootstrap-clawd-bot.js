#!/usr/bin/env node
/**
 * Bootstrap Clawd Bot
 *
 * Creates the official clawd-bot power user with cute display name "Clawd 🐾"
 * and generates an API token with required scopes for the bridge service.
 *
 * Usage:
 *   node scripts/bootstrap-clawd-bot.js
 *   # or via npm
 *   npm run bootstrap:clawd-bot
 */

require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const AgentIdentityService = require('../services/agentIdentityService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/commonly';

// Required scopes for the clawd-bot bridge service
const BOT_SCOPES = [
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
];

async function bootstrapClawdBot() {
  console.log('🐾 Bootstrapping Clawd Bot...\n');

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Create or get the clawd-bot user
    const clawdBot = await AgentIdentityService.getOrCreateAgentUser('clawd-bot');

    console.log('\n📋 Clawd Bot User:');
    console.log(`   Username: ${clawdBot.username}`);
    console.log(`   Display Name: ${clawdBot.botMetadata?.displayName || 'N/A'}`);
    console.log(`   Is Bot: ${clawdBot.isBot}`);
    console.log(`   Bot Type: ${clawdBot.botType}`);
    console.log(`   Official: ${clawdBot.botMetadata?.officialAgent}`);
    console.log(`   Capabilities: ${clawdBot.botMetadata?.capabilities?.join(', ') || 'none'}`);

    // Ensure scopes are set
    const existingScopes = clawdBot.apiTokenScopes || [];
    const missingScopes = BOT_SCOPES.filter((s) => !existingScopes.includes(s));
    if (missingScopes.length > 0) {
      clawdBot.apiTokenScopes = [...new Set([...existingScopes, ...BOT_SCOPES])];
      await clawdBot.save();
      console.log('\n🔐 Updated API token scopes:');
      clawdBot.apiTokenScopes.forEach((scope) => console.log(`   - ${scope}`));
    } else {
      console.log('\n🔐 API token scopes already configured');
    }

    // Generate API token if not exists
    if (!clawdBot.apiToken) {
      const token = clawdBot.generateApiToken();
      await clawdBot.save();
      console.log('\n🔑 Generated new API token:');
      console.log(`   ${token}`);
      console.log('\n⚠️  Save this token securely! It will not be shown again.');
    } else {
      console.log('\n🔑 API token already exists (not shown for security)');
      console.log('   To regenerate, delete the existing token first.');
    }

    // Sync to PostgreSQL
    await AgentIdentityService.syncUserToPostgreSQL(clawdBot);
    console.log('\n✅ Synced to PostgreSQL');

    console.log('\n🎉 Clawd Bot is ready!');
    console.log('\nTo use in the bridge service, set:');
    console.log('   COMMONLY_USER_TOKEN=<the token above>');
    console.log('   CLAWDBOT_AGENT_NAME=clawd-bot');
    console.log('   CLAWDBOT_INSTANCE_ID=default');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

bootstrapClawdBot();
