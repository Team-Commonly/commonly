/**
 * F172 M2: the bundle push mints its installation token from the connection's
 * own App, narrowed to the connection's repository for Connect. A push on a
 * Connect connection that asked for a tools token (or dropped the repository)
 * fails here. The token call is the first network step, so the stub stops the
 * push right there and nothing else runs.
 */
jest.mock('../../../services/githubAppService', () => ({
  getInstallationToken: jest.fn(async () => { throw new Error('stop-after-signing'); }),
}));
const GitHubAppService = require('../../../services/githubAppService');
const { pushSeatBranch } = require('../../../services/seatGithubPush');

const AGENT = 'cccccccccccccccccccccc01';
const args = () => ({
  ref: `refs/heads/seat/${AGENT}/fix-1`,
  baseOid: '1'.repeat(40),
  newOid: '2'.repeat(40),
  bundle: Buffer.from('bundle-bytes').toString('base64'),
});

beforeEach(() => { GitHubAppService.getInstallationToken.mockClear(); });

test('a Connect connection mints with the Connect App, narrowed to its repository', async () => {
  await expect(pushSeatBranch(args(), {
    type: 'github-app', installationId: '7001', app: 'connect', repositoryId: '555', owner: 'Outside-Team', repo: 'Widget',
  }, AGENT)).rejects.toBeTruthy();
  expect(GitHubAppService.getInstallationToken).toHaveBeenCalledTimes(1);
  expect(GitHubAppService.getInstallationToken).toHaveBeenCalledWith('7001', 'connect', '555', { fresh: true });
});

test('a tools connection mints with the tools App, unnarrowed', async () => {
  await expect(pushSeatBranch(args(), {
    type: 'github-app', installationId: '42', app: 'tools', owner: 'Team-Commonly', repo: 'commonly',
  }, AGENT)).rejects.toBeTruthy();
  expect(GitHubAppService.getInstallationToken).toHaveBeenCalledWith('42', 'tools', undefined, { fresh: true });
});
