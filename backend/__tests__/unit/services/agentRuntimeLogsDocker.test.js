jest.mock('child_process', () => ({ execFile: jest.fn() }));
const { execFile } = require('child_process');
const { getAgentRuntimeLogs } = require('../../../services/agentProvisionerService');
const { buildRuntimeLogFilters } = require('../../../routes/registry/helpers');

it.each([['bob', 'bob-default'], ['openclaw', 'default']])('filters shared Docker logs for %s', async (agentName, accountId) => {
  const previousK8s = process.env.AGENT_PROVISIONER_K8S;
  const previousDocker = process.env.AGENT_PROVISIONER_DOCKER;
  process.env.AGENT_PROVISIONER_K8S = '0';
  process.env.AGENT_PROVISIONER_DOCKER = '1';
  const own = `[commonly] [${accountId}] own line`;
  const peerId = accountId === 'default' ? 'bob-default' : 'default';
  execFile.mockImplementation((_bin, args, _options, callback) => {
    callback(null, { stdout: args[0] === 'ps' ? 'test-container' : [
      own, `[commonly] [${peerId}] peer line`, `diagnostic mentions ${accountId}`,
      `[commonly] [${accountId}-other] suffix peer`,
        `[commonly] [${peerId}] content repeats [commonly] [${accountId}] marker`,
    ].join('\n'), stderr: '' });
  });
  try {
    const filterTokens = buildRuntimeLogFilters({ runtimeType: 'moltbot', agentName, instanceId: 'default' });
    const result = await getAgentRuntimeLogs('moltbot', 'default', 200, { filterTokens });
    expect(result.logs).toBe(own);
  } finally {
    if (previousK8s === undefined) delete process.env.AGENT_PROVISIONER_K8S;
    else process.env.AGENT_PROVISIONER_K8S = previousK8s;
    if (previousDocker === undefined) delete process.env.AGENT_PROVISIONER_DOCKER;
    else process.env.AGENT_PROVISIONER_DOCKER = previousDocker;
  }
});
