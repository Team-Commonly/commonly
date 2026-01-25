const DiscordCommandService = require('./discordCommandService');
const DiscordService = require('./discordService');

async function runCommandForIntegration({
  commandName,
  integration,
  guildId,
  channelId,
}) {
  if (commandName === 'discord-push') {
    const discordService = new DiscordService(integration._id);
    const initialized = await discordService.initialize();

    if (!initialized || !discordService.commandService) {
      return {
        integration,
        result: {
          success: false,
          content: '❌ Discord integration not initialized.',
        },
      };
    }

    return {
      integration,
      result: await discordService.commandService.handlePushCommand(
        discordService,
      ),
    };
  }

  const commandService = new DiscordCommandService({
    integrationId: integration._id,
    guildId,
    channelId,
  });

  const initialized = await commandService.initialize();
  if (!initialized) {
    return {
      integration,
      result: {
        success: false,
        content: '❌ Discord integration not found.',
      },
    };
  }

  switch (commandName) {
    case 'commonly-summary':
      return {
        integration,
        result: await commandService.handleSummaryCommand(),
      };
    case 'discord-status':
      return {
        integration,
        result: await commandService.handleStatusCommand(),
      };
    case 'discord-enable':
      return {
        integration,
        result: await commandService.handleEnableCommand(),
      };
    case 'discord-disable':
      return {
        integration,
        result: await commandService.handleDisableCommand(),
      };
    default:
      return {
        integration,
        result: {
          success: false,
          content: '❌ Unknown command.',
        },
      };
  }
}

async function runDiscordCommandForIntegrations({
  commandName,
  integrations,
  guildId,
  channelId,
}) {
  const results = await Promise.all(
    integrations.map((integration) =>
      runCommandForIntegration({
        commandName,
        integration,
        guildId,
        channelId,
      }),
    ),
  );

  return results;
}

module.exports = {
  runCommandForIntegration,
  runDiscordCommandForIntegrations,
};
