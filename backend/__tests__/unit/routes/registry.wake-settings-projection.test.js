const { buildAgentInstallationPayload } = require('../../../routes/registry/helpers');

it('projects wake and heartbeat settings for the shared Settings reader', () => {
  const payload = buildAgentInstallationPayload({
    agentName: 'test-agent', instanceId: 'default', podId: 'pod-1', installedBy: 'owner',
    config: new Map([
      ['wakeOnMessage', { enabled: true, humanOnly: true }],
      ['boardWake', { enabled: false }],
      ['heartbeat', { everyMinutes: 90 }],
      ['runtime', { runtimeType: 'wrapper', webhookSecret: 'never-return' }],
    ]),
  });
  expect(payload.config).toEqual(expect.objectContaining({
    wakeOnMessage: { enabled: true, humanOnly: true },
    boardWake: { enabled: false },
    heartbeat: { everyMinutes: 90 },
  }));
  expect(JSON.stringify(payload)).not.toContain('never-return');
});
