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

  test('credential-shaped values in logged fields are redacted before serialization', () => {
    const credential = 'cm_agent_example123';
    const req = {
      body: {
        agentName: credential,
        instanceId: credential,
        config: { runtime: { runtimeType: credential } },
      },
      user: { id: 'owner-1' },
    };
    const res = { statusCode: 404, locals: {}, json: jest.fn() };
    logAgentInstallRefusal('/api/registry/install')(req, res, () => {});
    res.json({ error: 'Agent not found in registry' });
    expect(warn).toHaveBeenCalledTimes(1);
    const fullLine = warn.mock.calls[0].join(' ');
    expect(fullLine).not.toContain(credential);
    expect(JSON.parse(warn.mock.calls[0][1])).toEqual({
      route: '/api/registry/install',
      agentName: '[redacted]',
      instanceId: '[redacted]',
      runtimeType: 'unknown',
      reason: 'agent_not_found_in_registry',
      userId: 'owner-1',
    });
  });
});
