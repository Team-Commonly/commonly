const mongoose = require('mongoose');
const Integration = require('../models/Integration');
const DiscordService = require('../services/discordService');

/**
 * Register Discord Slash Commands
 * This script helps register slash commands for Discord integrations
 */
async function registerDiscordCommands() {
  console.log('🤖 Discord Slash Command Registration\n');

  try {
    // Connect to database
    const { MONGODB_URI } = process.env;
    if (!MONGODB_URI) {
      console.error('❌ MONGODB_URI environment variable is required');
      process.exit(1);
    }

    await mongoose.connect(MONGODB_URI);
    console.log('📦 Connected to MongoDB\n');

    // Find all Discord integrations
    const integrations = await Integration.find({
      type: 'discord',
      isActive: true,
    });

    if (integrations.length === 0) {
      console.log('❌ No active Discord integrations found.');
      console.log('   Please create a Discord integration first.\n');
      console.log('   You can create one by:');
      console.log('   1. Going to your chat pod');
      console.log('   2. Adding a Discord integration');
      console.log('   3. Following the setup instructions\n');
      return;
    }

    console.log(`📋 Found ${integrations.length} Discord integration(s):\n`);

    // Display integrations
    integrations.forEach((integration, index) => {
      console.log(`${index + 1}. Integration ID: ${integration._id}`);
      console.log(`   Server: ${integration.config.serverName || 'Unknown'}`);
      console.log(`   Channel: ${integration.config.channelName || 'Unknown'}`);
      console.log(`   Status: ${integration.status}`);
      console.log(`   Server ID: ${integration.config.serverId || 'Missing'}\n`);
    });

    // If multiple integrations, let user choose
    let selectedIntegration;
    if (integrations.length === 1) {
      selectedIntegration = integrations[0];
      console.log('✅ Using the only available integration\n');
    } else {
      console.log('Please select an integration to register commands for:');
      console.log('(Enter the number, or "all" to register for all integrations)');

      // For now, use the first one
      selectedIntegration = integrations[0];
      console.log('✅ Using the first integration\n');
    }

    // Register commands for selected integration
    if (selectedIntegration) {
      await registerCommandsForIntegration(selectedIntegration);
    }

    // If user chose "all", register for all integrations
    if (integrations.length > 1) {
      console.log('\n🔄 Registering commands for all integrations...\n');
      for (const integration of integrations) {
        await registerCommandsForIntegration(integration);
      }
    }
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n📦 Disconnected from MongoDB');
  }
}

/**
 * Register commands for a specific integration
 */
async function registerCommandsForIntegration(integration) {
  console.log(`🔧 Registering commands for integration: ${integration._id}`);
  console.log(`🏠 Server: ${integration.config.serverName || 'Unknown'}`);

  try {
    // Validate integration has required fields
    if (!integration.config.serverId) {
      console.log('❌ Missing server ID in integration config');
      return false;
    }

    // Create Discord service and register commands
    const discordService = new DiscordService(integration._id);
    await discordService.initialize();

    console.log('📡 Registering slash commands with Discord...');
    const success = await discordService.registerSlashCommands(integration.config.serverId);

    if (success) {
      console.log('✅ Commands registered successfully!');
      console.log('   Available commands:');
      console.log('   - /commonly-summary');
      console.log('   - /discord-status');
      console.log('   - /discord-enable');
      console.log('   - /discord-disable');
      console.log('');
      return true;
    }
    console.log('❌ Failed to register commands');
    console.log('   Possible issues:');
    console.log('   - Bot token is invalid');
    console.log('   - Bot lacks permissions');
    console.log('   - Server ID is incorrect');
    console.log('   - Discord API is down');
    console.log('');
    return false;
  } catch (error) {
    console.error('❌ Error registering commands:', error.message);
    console.log('');
    return false;
  }
}

/**
 * List all available integrations
 */
async function listIntegrations() {
  console.log('📋 Available Discord Integrations:\n');

  const integrations = await Integration.find({
    type: 'discord',
    isActive: true,
  });

  if (integrations.length === 0) {
    console.log('No Discord integrations found.');
    return;
  }

  integrations.forEach((integration, index) => {
    console.log(`${index + 1}. ${integration._id}`);
    console.log(`   Server: ${integration.config.serverName || 'Unknown'}`);
    console.log(`   Channel: ${integration.config.channelName || 'Unknown'}`);
    console.log(`   Status: ${integration.status}`);
    console.log('');
  });
}

// Handle command line arguments
const args = process.argv.slice(2);
const command = args[0];

if (command === 'list') {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => listIntegrations())
    .then(() => mongoose.disconnect())
    .catch(console.error);
} else {
  // Default: register commands
  registerDiscordCommands();
}

module.exports = { registerDiscordCommands, listIntegrations };
