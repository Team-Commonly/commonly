/**
 * Every GitHub REST call the broker makes is bounded. An approved call the
 * sweep cannot see end is judged dead after APPROVED_CALL_SETTLE_MS, so a hung
 * request must fail long before that, on each step of a multi-step commit.
 * `timeout` alone is an idle timer in axios's Node adapter, so the deadline is
 * also a signal: a response that trickles cannot outlive it.
 */
jest.mock('axios', () => {
  const answer = jest.fn(async () => ({ data: {} }));
  return {
    get: answer, post: answer, put: answer, patch: answer,
  };
});
const axios = require('axios');
const GitHubAppService = require('../../../services/githubAppService');
const { isWriteUnknown } = require('../../../services/brokerWriteOutcome');

const { GITHUB_REST_TIMEOUT_MS } = GitHubAppService;
const git = { owner: 'octo', repo: 'demo' };

const brokerCalls = [
  ['listOpenIssues', git],
  ['createIssue', { ...git, title: 't' }],
  ['addIssueComment', { ...git, issueNumber: 1, body: 'b' }],
  ['closeIssue', { ...git, issueNumber: 1 }],
  ['getIssue', { ...git, issueNumber: 1 }],
  ['getPullRequest', { ...git, pullNumber: 1 }],
  ['createPullRequest', {
    ...git, title: 't', head: 'h', base: 'b', 
  }],
  ['listPullRequestFiles', { ...git, pullNumber: 1 }],
  ['mergePullRequest', { ...git, pullNumber: 1 }],
  ['createPullReview', {
    ...git, pullNumber: 1, event: 'COMMENT', body: 'b', 
  }],
  ['getBranchHead', { ...git, branch: 'main' }],
  ['getCommitTree', { ...git, sha: 'a' }],
  ['getDefaultBranch', git],
  ['getTreeEntries', { ...git, sha: 'a' }],
  ['createTextTree', { ...git, baseTree: 'a', files: [] }],
  ['createCommit', {
    ...git, message: 'm', tree: 't', parents: [],
  }],
  ['createBranchRef', { ...git, branch: 'b', sha: 'a' }],
  ['fastForwardBranchRef', { ...git, branch: 'b', sha: 'a' }],
];

const configOf = (call) => call.find((arg) => arg && typeof arg === 'object' && arg.headers);

beforeEach(() => {
  axios.get.mockClear();
  jest.spyOn(GitHubAppService, '_apiHeaders').mockResolvedValue({ Authorization: 'token x' });
});
afterEach(() => jest.restoreAllMocks());

describe('GitHub REST calls on the broker path', () => {
  it.each(brokerCalls)('%s carries a timeout and a deadline', async (method, options) => {
    if (method === 'listOpenIssues') axios.get.mockResolvedValueOnce({ data: [] });
    await GitHubAppService[method](options);
    expect(axios.get).toHaveBeenCalled();
    axios.get.mock.calls.forEach((call) => {
      const config = configOf(call);
      expect(config).toMatchObject({ timeout: GITHUB_REST_TIMEOUT_MS });
      expect(config.signal).toBeInstanceOf(AbortSignal);
    });
  });

  const writes = ['createIssue', 'addIssueComment', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'createPullReview',
    'createTextTree', 'createCommit', 'createBranchRef', 'fastForwardBranchRef'];
  const reads = ['listOpenIssues', 'getIssue', 'getPullRequest', 'listPullRequestFiles', 'getBranchHead',
    'getCommitTree', 'getDefaultBranch', 'getTreeEntries'];
  const optionsOf = (method) => brokerCalls.find(([name]) => name === method)[1];
  const fired = (code) => Object.assign(new Error('deadline'), { code });
  const failWith = (error) => {
    axios.get.mockRejectedValueOnce(error);
  };

  describe.each(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'])('a %s', (code) => {
    it.each(writes)('on %s may have landed', async (method) => {
      failWith(fired(code));
      const error = await GitHubAppService[method](optionsOf(method)).catch((e) => e);
      expect(isWriteUnknown(error)).toBe(true);
    });

    it.each(reads)('on %s sent no write', async (method) => {
      failWith(fired(code));
      const error = await GitHubAppService[method](optionsOf(method)).catch((e) => e);
      expect(error.code).toBe(code);
      expect(isWriteUnknown(error)).toBe(false);
    });
  });

  it('a write GitHub answered with an error is an ordinary failure', async () => {
    failWith(Object.assign(new Error('500'), { response: { status: 500 } }));
    const error = await GitHubAppService.createIssue(optionsOf('createIssue')).catch((e) => e);
    expect(error.response.status).toBe(500);
    expect(isWriteUnknown(error)).toBe(false);
  });

  it('a token mint that times out before a write sent nothing', async () => {
    GitHubAppService._apiHeaders.mockRejectedValueOnce(fired('ECONNABORTED'));
    const error = await GitHubAppService.createIssue(optionsOf('createIssue')).catch((e) => e);
    expect(isWriteUnknown(error)).toBe(false);
  });

  it('closing with a comment: a timeout after the comment landed counts, even on the token mint', async () => {
    GitHubAppService._apiHeaders
      .mockResolvedValueOnce({ Authorization: 'token x' })
      .mockRejectedValueOnce(fired('ECONNABORTED'));
    const error = await GitHubAppService.closeIssue({ ...optionsOf('closeIssue'), comment: 'c' }).catch((e) => e);
    expect(isWriteUnknown(error)).toBe(true);
  });

  it('minting the installation token is bounded too', async () => {
    jest.restoreAllMocks();
    jest.spyOn(GitHubAppService, 'generateAppJWT').mockReturnValue('jwt');
    GitHubAppService._resetTokenCache();
    axios.post.mockResolvedValueOnce({ data: { token: 't', expires_at: new Date(Date.now() + 3600000).toISOString() } });
    await GitHubAppService.getInstallationToken('install-1', 'tools');
    expect(configOf(axios.post.mock.calls.at(-1))).toMatchObject({ timeout: GITHUB_REST_TIMEOUT_MS });
  });
});
