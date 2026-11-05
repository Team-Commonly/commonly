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

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

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

// F161 item 8: the bridge commands make sense only in a guild channel bound to a pod.
test('every bridge command is offered in guilds only', () => {
  const commands = require('../../../config/discordApplicationCommands.json');
  BRIDGE.forEach((name) => {
    expect(commands.find((c) => c.name === name).contexts).toEqual([0]);
  });
});

// F161 item 5: the boot-time PUT cannot hang boot, and a failure is an exit code.
describe('deploy at boot', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(DiscordCommandDeployment.prototype, 'sleep').mockResolvedValue();
  });

  test('the PUT carries a 10 s timeout', async () => {
    axios.put.mockResolvedValue({ status: 200 });
    await new DiscordCommandDeployment().deploy();
    expect(axios.put.mock.calls[0][2].timeout).toBe(10_000);
  });

  test('main sets exit code 1 when every attempt fails', async () => {
    axios.put.mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }));
    await DiscordCommandDeployment.main(['deploy']);
    expect(axios.put).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
  });

  test('main sets exit code 1 when credentials are missing', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    await DiscordCommandDeployment.main(['deploy']);
    expect(axios.put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test('main leaves the exit code alone on success', async () => {
    axios.put.mockResolvedValue({ status: 200 });
    await DiscordCommandDeployment.main(['deploy']);
    expect(process.exitCode).toBeUndefined();
  });
});
