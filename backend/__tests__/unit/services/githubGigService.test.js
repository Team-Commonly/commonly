const mockIntegrationFind = jest.fn();
const mockTaskUpdate = jest.fn();
const mockPost = jest.fn();
const mockEmit = jest.fn();
jest.mock('../../../models/GithubGigBinding', () => ({ findOne: (...args) => mockIntegrationFind(...args) }));
jest.mock('../../../models/Task', () => ({ findOneAndUpdate: (...args) => mockTaskUpdate(...args) }));
jest.mock('../../../services/agentIdentityService', () => ({ getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot' }) }));
jest.mock('../../../services/agentMessageService', () => ({ _postToTarget: (...args) => mockPost(...args) }));
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: (...args) => mockEmit(...args) }));

const {
  githubLocation, boundPodForGithubEvent, buildGithubGigCard,
  completeTaskForMergedPull, handleGithubGig,
} = require('../../../services/githubGigService');

const podId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const location = { installationId: '7654321', owner: 'Team-Commonly', repo: 'commonly', number: '42' };
const payload = {
  action: 'closed', installation: { id: 7654321 },
  repository: { owner: { login: 'Team-Commonly' }, name: 'commonly' },
  pull_request: { number: 42, merged: true, title: '<script>outsider</script>' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ message: { id: 'm1' } });
  mockTaskUpdate.mockResolvedValue(null);
});

test('accepts only structural repository coordinates and numeric ids', () => {
  expect(githubLocation(payload)).toEqual(location);
  expect(githubLocation({ ...payload, repository: { owner: { login: 'github.com.evil' }, name: 'repo/x' } })).toBeNull();
  expect(githubLocation({ ...payload, pull_request: { number: '1/../../admin' } })).toBeNull();
});

test('one indexed connection lookup selects an explicitly bound pod', async () => {
  mockIntegrationFind.mockReturnValue({ select: () => ({ lean: async () => ({ podId }) }) });
  expect(await boundPodForGithubEvent({ ...location, repo: 'COMMONLY' })).toBe(podId);
  expect(mockIntegrationFind).toHaveBeenCalledWith(expect.objectContaining({
    installationId: location.installationId, owner: 'team-commonly', repo: 'commonly',
  }));
});

test('card excludes outsider text and builds a canonical GitHub URL', () => {
  const card = buildGithubGigCard('pull_request', payload, location);
  expect(JSON.stringify(card)).not.toContain('outsider');
  expect(card.elements[2].href).toBe('https://github.com/Team-Commonly/commonly/pull/42');
  expect(card.elements[0].children[0].text).toBe('Merged');
});

test('a merged PR completes only its matching open task and emits a board update', async () => {
  const task = { taskId: 'TASK-11', status: 'done' };
  mockTaskUpdate.mockResolvedValue(task);
  const href = 'https://github.com/Team-Commonly/commonly/pull/42';
  await completeTaskForMergedPull(podId, href);
  const [filter, update] = mockTaskUpdate.mock.calls[0];
  expect(String(filter.podId)).toBe(podId);
  expect(filter.prUrl).toBe(href);
  expect(filter.status).toEqual({ $in: ['pending', 'claimed'] });
  expect(update.$set.status).toBe('done');
  expect(mockEmit).toHaveBeenCalledWith(podId, task, 'updated');
});

test('posts a display card while agent-visible content stays fixed', async () => {
  await handleGithubGig({ eventType: 'pull_request', payload, podId, location });
  const posted = mockPost.mock.calls[0][0];
  expect(posted.content).toBe('[GitHub activity]');
  expect(posted.payload.kind).toBe('gig-card');
  expect(posted.noOutboundRelay).toBe(true);
  expect(JSON.stringify(posted.payload)).not.toContain('outsider');
  expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
  expect(mockTaskUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockPost.mock.invocationCallOrder[0]);
});

test('a task write failure prevents the card post, allowing a retry', async () => {
  mockTaskUpdate.mockRejectedValueOnce(new Error('temporary task write failure'));
  await expect(handleGithubGig({ eventType: 'pull_request', payload, podId, location })).rejects.toThrow('temporary');
  expect(mockPost).not.toHaveBeenCalled();
});
