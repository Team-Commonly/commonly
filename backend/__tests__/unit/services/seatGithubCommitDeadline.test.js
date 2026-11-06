/**
 * A commit is several GitHub requests. Up to its first write nothing has
 * changed at the provider, so a deadline there is an ordinary failure. From
 * that write on, a deadline on any step counts as an unknown outcome.
 */
const mockGithub = {
  getBranchHead: jest.fn(),
  getDefaultBranch: jest.fn(),
  getCommitTree: jest.fn(),
  getTreeEntries: jest.fn(),
  createTextTree: jest.fn(),
  createCommit: jest.fn(),
  createBranchRef: jest.fn(),
  fastForwardBranchRef: jest.fn(),
};
jest.mock('../../../services/githubAppService', () => mockGithub);
const { commitSeatFiles } = require('../../../services/seatGithubCommit');
const { isWriteUnknown } = require('../../../services/brokerWriteOutcome');

const PARENT = 'a'.repeat(40);
const AGENT = '6a920d43b08dee6c42a81c9e';
const connection = {
  owner: 'octo', repo: 'demo', installationId: 'install-1', app: 'tools', repositoryId: '1',
};
const raw = () => ({
  branch: `seat/${AGENT}/work`,
  base: 'main',
  message: 'm',
  files: [{ path: 'a.txt', content: 'a' }],
  parentSha: PARENT,
  branchExists: true,
});
const fired = () => Object.assign(new Error('deadline'), { code: 'ECONNABORTED' });
const commit = () => commitSeatFiles(raw(), connection, AGENT).catch((error) => error);

beforeEach(() => {
  jest.resetAllMocks();
  mockGithub.getBranchHead.mockResolvedValue(PARENT);
  mockGithub.getDefaultBranch.mockResolvedValue('main');
  mockGithub.getCommitTree.mockResolvedValue('b'.repeat(40));
  mockGithub.createTextTree.mockResolvedValue('c'.repeat(40));
  mockGithub.createCommit.mockResolvedValue('d'.repeat(40));
  mockGithub.getTreeEntries.mockResolvedValue([]);
});

describe('a commit whose deadline fires', () => {
  it('a clean commit is untouched', async () => {
    await expect(commit()).resolves.toMatchObject({ commitSha: 'd'.repeat(40) });
  });

  it.each(['getBranchHead', 'getDefaultBranch', 'getCommitTree'])('on the read %s, before any write, is ordinary', async (step) => {
    mockGithub[step].mockReset().mockRejectedValue(fired());
    expect(isWriteUnknown(await commit())).toBe(false);
  });

  it('on the first write\'s own token mint, before anything was sent, is ordinary', async () => {
    mockGithub.createTextTree.mockRejectedValue(fired());
    expect(isWriteUnknown(await commit())).toBe(false);
  });

  it.each(['createCommit', 'fastForwardBranchRef'])('on %s, after the first write, counts as unknown', async (step) => {
    mockGithub[step].mockRejectedValue(fired());
    expect(isWriteUnknown(await commit())).toBe(true);
  });

  it('a refusal after the first write stays what it was', async () => {
    mockGithub.fastForwardBranchRef.mockRejectedValue(Object.assign(new Error('422'), { response: { status: 422 } }));
    const error = await commit();
    expect(error).toMatchObject({ code: 'stale_branch' });
    expect(isWriteUnknown(error)).toBe(false);
  });
});
