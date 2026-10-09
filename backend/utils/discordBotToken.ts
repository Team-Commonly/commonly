/**
 * Discord bot token resolution — the ENVIRONMENT is authoritative.
 *
 * The token is instance-wide (`DISCORD_BOT_TOKEN`), so rotating it must reach
 * every integration that was connected before the rotation. A stored copy on
 * the row (`DiscordIntegration.botToken`, or the legacy
 * `Integration.config.botToken`) therefore never wins over the env value — it
 * is only a fallback for rows that predate the copy being retired.
 *
 * This is the single definition of that precedence. Before it, five read sites
 * each resolved the token themselves and three of them prefered the stored
 * copy, which is why a rotation reached new connectors and not existing ones
 * (TASK-124; Vera 73344-73346 / 73384, Wren 73376/73377).
 *
 * Reads `process.env` per call rather than through `config/discord` (which
 * freezes it at module load) so every caller shares one precedence and the
 * value is testable per case.
 */
export const resolveDiscordBotToken = (...stored: unknown[]): string | undefined => {
  const fromEnv = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  for (const candidate of stored) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return undefined;
};

export default resolveDiscordBotToken;
