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

// F161 (CodeRabbit 4475816306): axios's `timeout` stops counting once headers
// arrive, so a body that trickles forever would still hold boot. Each attempt
// has a wall-clock deadline over the whole request and response.
describe('the per-attempt deadline', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(DiscordCommandDeployment.prototype, 'sleep').mockResolvedValue();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  // A request that never settles unless its signal aborts it.
  const hangUntilAborted = (_url, _body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
  });

  test('a hanging response is aborted at 15 s, and three of them fail the deploy', async () => {
    axios.put.mockImplementation(hangUntilAborted);
    const done = new DiscordCommandDeployment().deploy();
    await jest.advanceTimersByTimeAsync(14_999);
    expect(axios.put).toHaveBeenCalledTimes(1);
    expect(axios.put.mock.calls[0][2].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(axios.put.mock.calls[0][2].signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(30_000);
    const result = await done;
    expect(axios.put).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
  });

  test('a settled attempt leaves no deadline timer behind', async () => {
    axios.put.mockResolvedValue({ status: 200 });
    await new DiscordCommandDeployment().deploy();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// F161 items 6 and 7: verify's exit status, and a registered command whose
// shape has gone stale (contexts or options) counts as a failure.
describe('verify', () => {
  const commands = require('../../../config/discordApplicationCommands.json');
  const live = () => JSON.parse(JSON.stringify(commands)).map((c) => ({ id: `id-${c.name}`, application_id: 'app-1', version: '1', ...c }));

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('a matching set exits 0', async () => {
    axios.get.mockResolvedValue({ status: 200, data: live() });
    await DiscordCommandDeployment.main(['verify']);
    expect(process.exitCode).toBeUndefined();
  });

  test('a missing command exits 1', async () => {
    axios.get.mockResolvedValue({ status: 200, data: live().filter((c) => c.name !== 'tldr') });
    await DiscordCommandDeployment.main(['verify']);
    expect(process.exitCode).toBe(1);
  });

  test('an API error exits 1', async () => {
    axios.get.mockRejectedValue(new Error('503'));
    await DiscordCommandDeployment.main(['verify']);
    expect(process.exitCode).toBe(1);
  });

  test('a command registered without its guild-only context is stale', async () => {
    const data = live().map((c) => (c.name === 'mute' ? { ...c, contexts: null } : c));
    axios.get.mockResolvedValue({ status: 200, data });
    const result = await new DiscordCommandDeployment().verifyDeployment();
    expect(result.success).toBe(false);
    expect(result.staleCommands).toEqual(['mute']);
  });

  test('a command whose choices changed is stale', async () => {
    const data = live().map((c) => (c.name === 'mode'
      ? { ...c, options: [{ ...c.options[0], choices: [{ name: 'mirror', value: 'mirror' }] }] }
      : c));
    axios.get.mockResolvedValue({ status: 200, data });
    const result = await new DiscordCommandDeployment().verifyDeployment();
    expect(result.staleCommands).toEqual(['mode']);
  });

  test('fields Discord adds on its own are not a difference', async () => {
    const data = live().map((c) => ({ ...c, dm_permission: true, nsfw: false, integration_types: [0] }));
    axios.get.mockResolvedValue({ status: 200, data });
    const result = await new DiscordCommandDeployment().verifyDeployment();
    expect(result.success).toBe(true);
  });
});
