/**
 * TASK-124 — DISCORD_BOT_TOKEN is the authority for the Discord bot token.
 *
 * Before this, five read sites resolved the token themselves and three of them
 * prefered a copy stored on the integration row, so rotating the env var
 * reached new connectors and not existing ones (Vera 73344-73346: all three
 * `discord_integrations` documents carried a 72-char copy; Wren 73376/73377).
 *
 * This file pins the precedence itself, because it is now one definition that
 * every site calls: env first, stored copy only as a fallback for rows that
 * predate the copy being retired.
 */
const { resolveDiscordBotToken } = require('../../../utils/discordBotToken');

const FROM_ENV = 'env-token-after-rotation';
const STORED = 'stored-token-from-before-rotation';

describe('resolveDiscordBotToken', () => {
  const saved = process.env.DISCORD_BOT_TOKEN;

  afterEach(() => {
    if (saved === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = saved;
  });

  it('prefers the environment over a stored copy', () => {
    process.env.DISCORD_BOT_TOKEN = FROM_ENV;

    expect(resolveDiscordBotToken(STORED)).toBe(FROM_ENV);
  });

  it('prefers the environment even when the stored copy looks like a real token', () => {
    process.env.DISCORD_BOT_TOKEN = FROM_ENV;

    // 72 chars, the shape Vera found in all three production documents.
    const realLooking = 'M'.repeat(72);
    expect(realLooking).toHaveLength(72);
    expect(resolveDiscordBotToken(realLooking, realLooking)).toBe(FROM_ENV);
  });

  it('falls back to the first non-empty stored candidate when the env var is absent', () => {
    delete process.env.DISCORD_BOT_TOKEN;

    expect(resolveDiscordBotToken(undefined, '', '   ', STORED)).toBe(STORED);
  });

  it('treats a blank or whitespace env var as absent', () => {
    process.env.DISCORD_BOT_TOKEN = '   ';

    expect(resolveDiscordBotToken(STORED)).toBe(STORED);
  });

  it('returns undefined when neither the environment nor a stored copy has a token', () => {
    delete process.env.DISCORD_BOT_TOKEN;

    expect(resolveDiscordBotToken()).toBeUndefined();
    expect(resolveDiscordBotToken(null, undefined, '')).toBeUndefined();
  });

  it('trims the value it returns', () => {
    process.env.DISCORD_BOT_TOKEN = `  ${FROM_ENV}  `;

    expect(resolveDiscordBotToken()).toBe(FROM_ENV);
  });
});
