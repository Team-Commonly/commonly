jest.mock('playwright-core', () => ({ chromium: { connectOverCDP: jest.fn(async () => ({ contexts: () => [] })) } }));

const { chromium } = require('playwright-core');
const { steelRequest, connectSteel, agentComputerEnabled } = require('../../../services/agentComputerBroker');

const ENV = ['AGENT_COMPUTER_STEEL_TOKEN', 'AGENT_COMPUTER_ENABLED', 'AGENT_COMPUTER_STEEL_API_URL_TEMPLATE',
  'AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE', 'AGENT_COMPUTER_WAKER_URL', 'AGENT_COMPUTER_WAKER_TOKEN'];

describe('the broker authenticates to the Steel gate', () => {
  const saved = {};
  beforeEach(() => {
    ENV.forEach((key) => { saved[key] = process.env[key]; });
    process.env.AGENT_COMPUTER_STEEL_TOKEN = 'gate-token';
  });
  afterEach(() => {
    ENV.forEach((key) => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
    jest.restoreAllMocks();
  });

  test('every Steel API call carries the gate token', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, json: async () => ({ sessions: [] }) }));
    await steelRequest('http://steel-x:3000/v1/sessions', 'GET');
    await steelRequest('http://steel-x:3000/v1/sessions', 'POST');
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer gate-token' });
    expect(fetchSpy.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer gate-token', 'content-type': 'application/json' });
    expect(fetchSpy.mock.calls[1][1].body).toBe('{"persist":true}');
  });

  test('the CDP connection carries the gate token', async () => {
    await connectSteel('ws://steel-x:3000');
    expect(chromium.connectOverCDP).toHaveBeenCalledWith('ws://steel-x:3000', expect.objectContaining({
      headers: { Authorization: 'Bearer gate-token' },
    }));
  });

  test('the computer stays off without the gate token', () => {
    Object.assign(process.env, {
      AGENT_COMPUTER_ENABLED: 'true',
      AGENT_COMPUTER_STEEL_API_URL_TEMPLATE: 'http://steel-{userId}:3000',
      AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE: 'ws://steel-{userId}:3000',
      AGENT_COMPUTER_WAKER_URL: 'http://waker',
      AGENT_COMPUTER_WAKER_TOKEN: 'w',
    });
    expect(agentComputerEnabled()).toBe(true);
    delete process.env.AGENT_COMPUTER_STEEL_TOKEN;
    expect(agentComputerEnabled()).toBe(false);
  });
});
