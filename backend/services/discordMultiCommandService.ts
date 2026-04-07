// eslint-disable-next-line global-require
const DiscordCommandService = require('./discordCommandService');
// eslint-disable-next-line global-require
const DiscordService = require('./discordService');

interface Integration {
  _id: unknown;
  [key: string]: unknown;
}

interface CommandResult {
  success: boolean;
  content: string;
  [key: string]: unknown;
}

interface IntegrationCommandResult {
  integration: Integration;
  result: CommandResult;
}

interface RunCommandOptions {
  commandName: string;
  integration: Integration;
  guildId?: string;
  channelId?: string;
}

interface RunMultiCommandOptions {
  commandName: string;
  integrations: Integration[];
  guildId?: string;
  channelId?: string;
}

async function runCommandForIntegration({
  commandName,
  integration,
  guildId,
  channelId,
}: RunCommandOptions): Promise<IntegrationCommandResult> {
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
}: RunMultiCommandOptions): Promise<IntegrationCommandResult[]> {
  const results = await Promise.all(
    integrations.map((integration) => runCommandForIntegration({
      commandName,
      integration,
      guildId,
      channelId,
    })),
  );

  return results;
}

export { runCommandForIntegration, runDiscordCommandForIntegrations };
