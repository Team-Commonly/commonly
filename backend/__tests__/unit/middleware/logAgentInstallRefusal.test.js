const { logAgentInstallRefusal } = require('../../../middleware/logAgentInstallRefusal');

describe('agent install refusal logging', () => {
  let warn;

  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  test('machine placement refusal records wrapper and omits credentials', () => {
    const req = {
      body: { agentName: 'my-agent', instanceId: 'default', machineId: 'machine-1', token: 'secret' },
      user: { id: 'owner-1' },
    };
    const res = {
      statusCode: 200,
      locals: {},
      json: jest.fn(),
    };
    const next = jest.fn();
    logAgentInstallRefusal('/api/agent-binding/request', 'wrapper')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.statusCode = 404;
    res.json({ message: 'Agent identity not found' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(warn.mock.calls[0][1]);
    expect(line).toEqual({
      route: '/api/agent-binding/request',
      agentName: 'my-agent',
      instanceId: 'default',
      runtimeType: 'wrapper',
      reason: 'agent_identity_not_found',
      userId: 'owner-1',
    });
    expect(warn.mock.calls[0].join(' ')).not.toContain('secret');
    expect(warn.mock.calls[0].join(' ')).not.toContain('machine-1');
  });
});
