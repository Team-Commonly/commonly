#!/usr/bin/env node
/**
 * Bootstrap Cuz (OpenClaw Agent)
 *
 * Creates the official openclaw agent user with display name "Cuz 🦞"
 * and generates an API token with required scopes for the bridge service.
 *
 * Usage:
 *   node scripts/bootstrap-clawd-bot.js
 *   # or via npm
 *   npm run bootstrap:clawd-bot
 */

require('dotenv').config();

const mongoose = require('mongoose');
const AgentIdentityService = require('../services/agentIdentityService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/commonly';

// Required scopes for the openclaw bridge service
const BOT_SCOPES = [
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
];

async function bootstrapOpenClawBot() {
  console.log('🦞 Bootstrapping Cuz (OpenClaw Agent)...\n');

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Create or get the openclaw agent user (official instance)
    const cuzBot = await AgentIdentityService.getOrCreateAgentUser('openclaw');

    console.log('\n📋 Cuz Bot User:');
    console.log(`   Username: ${cuzBot.username}`);
    console.log(`   Display Name: ${cuzBot.botMetadata?.displayName || 'N/A'}`);
    console.log(`   Agent Type: ${cuzBot.botMetadata?.agentType || 'N/A'}`);
    console.log(`   Icon: ${cuzBot.botMetadata?.icon || '🤖'}`);
    console.log(`   Is Bot: ${cuzBot.isBot}`);
    console.log(`   Bot Type: ${cuzBot.botType}`);
    console.log(`   Official: ${cuzBot.botMetadata?.officialAgent}`);
    console.log(`   Runtime: ${cuzBot.botMetadata?.runtime || 'unknown'}`);
    console.log(`   Capabilities: ${cuzBot.botMetadata?.capabilities?.join(', ') || 'none'}`);

    // Ensure scopes are set
    const existingScopes = cuzBot.apiTokenScopes || [];
    const missingScopes = BOT_SCOPES.filter((s) => !existingScopes.includes(s));
    if (missingScopes.length > 0) {
      cuzBot.apiTokenScopes = [...new Set([...existingScopes, ...BOT_SCOPES])];
      await cuzBot.save();
      console.log('\n🔐 Updated API token scopes:');
      cuzBot.apiTokenScopes.forEach((scope) => console.log(`   - ${scope}`));
    } else {
      console.log('\n🔐 API token scopes already configured');
    }

    // Generate API token if not exists
    if (!cuzBot.apiToken) {
      const token = cuzBot.generateApiToken();
      await cuzBot.save();
      console.log('\n🔑 Generated new API token:');
      console.log(`   ${token}`);
      console.log('\n⚠️  Save this token securely! It will not be shown again.');
    } else {
      console.log('\n🔑 API token already exists (not shown for security)');
      console.log('   To regenerate, delete the existing token first.');
    }

    // Sync to PostgreSQL
    await AgentIdentityService.syncUserToPostgreSQL(cuzBot);
    console.log('\n✅ Synced to PostgreSQL');

    console.log('\n🎉 Cuz 🦞 is ready!');
    console.log('\nTo use in the bridge service, set:');
    console.log('   COMMONLY_USER_TOKEN=<the token above>');
    console.log('   CLAWDBOT_AGENT_TYPE=openclaw');
    console.log('   CLAWDBOT_INSTANCE_ID=default');
    console.log('\nMention aliases: @cuz, @clawd, @openclaw');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

bootstrapOpenClawBot();
