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
  /** A bind-rule refusal (F143), not an error; see `combinedReplyIsPublic`. */
  refused?: boolean;
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
  /** The caller's Discord id; the sync toggles admit only the installer (F161). */
  actorId?: string;
}

interface RunMultiCommandOptions {
  commandName: string;
  integrations: Integration[];
  guildId?: string;
  channelId?: string;
  actorId?: string;
}

async function runCommandForIntegration({
  commandName,
  integration,
  guildId,
  channelId,
  actorId,
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
        result: await commandService.handleEnableCommand(actorId),
      };
    case 'discord-disable':
      return {
        integration,
        result: await commandService.handleDisableCommand(actorId),
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
  actorId,
}: RunMultiCommandOptions): Promise<IntegrationCommandResult[]> {
  const results = await Promise.all(
    integrations.map((integration) => runCommandForIntegration({
      commandName,
      integration,
      guildId,
      channelId,
      actorId,
    })),
  );

  return results;
}

/**
 * Whether the one reply that folds several pods' results is public. A bind-rule
 * refusal (F143) carries only a short, non-sensitive sentence, so it does not
 * make the allowed pods' summaries private; a real error still does. A reply
 * with no success at all stays ephemeral.
 */
const combinedReplyIsPublic = (results: Array<{ result: { success: boolean; refused?: boolean } }>): boolean => (
  results.some(({ result }) => result.success)
  && results.every(({ result }) => result.success || result.refused === true)
);

export { runCommandForIntegration, runDiscordCommandForIntegrations, combinedReplyIsPublic };
