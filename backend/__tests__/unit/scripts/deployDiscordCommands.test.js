// F133: the Discord command set is registered as ONE bulk overwrite (PUT) of
// the application's global commands, carrying every bridge command.
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const DiscordCommandDeployment = require('../../../scripts/deploy-discord-commands');

const BRIDGE = ['mode', 'status', 'mute', 'unmute', 'tldr', 'summary', 'help'];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DISCORD_CLIENT_ID = 'app-1';
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('one PUT to the global commands endpoint, carrying all seven bridge commands', async () => {
  axios.put.mockResolvedValue({ status: 200 });
  const result = await new DiscordCommandDeployment().deploy();
  expect(result.success).toBe(true);
  expect(axios.put).toHaveBeenCalledTimes(1);
  expect(axios.post).not.toHaveBeenCalled();
  const [url, commands, options] = axios.put.mock.calls[0];
  expect(url).toBe('https://discord.com/api/v10/applications/app-1/commands');
  expect(options.headers.Authorization).toBe('Bot bot-token');
  const names = commands.map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(BRIDGE));
  expect(new Set(names).size).toBe(names.length);
  // The route answers what is registered: the set and the handler share one list.
  const { DISCORD_RELAY_COMMAND_NAMES } = require('../../../services/discordRelayCommandService');
  expect([...DISCORD_RELAY_COMMAND_NAMES].sort()).toEqual([...BRIDGE].sort());
});

test('/mode offers exactly the two modes, and /mute takes a duration', () => {
  const commands = require('../../../config/discordApplicationCommands.json');
  const mode = commands.find((c) => c.name === 'mode');
  expect(mode.options[0].choices.map((c) => c.value)).toEqual(['mirror', 'attention']);
  const mute = commands.find((c) => c.name === 'mute');
  expect(mute.options[0]).toMatchObject({ name: 'duration', type: 3, required: false });
});
