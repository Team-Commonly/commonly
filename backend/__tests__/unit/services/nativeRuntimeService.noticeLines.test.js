/**
 * F300: a notice line is stored under the agent, and it's for the people in the
 * room. Read back as the agent's own words, one made a hosted agent tell someone
 * after Start that "the stopped notice earlier was out of date".
 */
const mockListPodMessages = jest.fn();
jest.mock('../../../repositories/messageRepository', () => ({
  listPodMessages: (...args) => mockListPodMessages(...args),
}));

const { fetchRecentPodMessages } = require('../../../services/nativeRuntimeService');

const line = (action) => ({
  id: action,
  content: `Nova ${action}`,
  message_type: 'system',
  payload: { kind: 'system-action', action },
});

it.each([
  'agent-stopped', 'agent-removed', 'agent-paused', 'agent-offline', 'agent-not-connected', 'mention-unanswered',
])('leaves %s out of what an agent reads', async (action) => {
  mockListPodMessages.mockResolvedValue([{ id: 'a', content: '@nova hello' }, line(action)]);
  expect((await fetchRecentPodMessages('pod-1', 10)).map((row) => row.id)).toEqual(['a']);
});

it('keeps a claim line, which tells the agent who has the work', async () => {
  mockListPodMessages.mockResolvedValue([line('task-claimed')]);
  expect(await fetchRecentPodMessages('pod-1', 10)).toHaveLength(1);
});

it('keeps anything not written as a system line, whatever its payload says', async () => {
  mockListPodMessages.mockResolvedValue([{ ...line('agent-stopped'), message_type: 'text' }]);
  expect(await fetchRecentPodMessages('pod-1', 10)).toHaveLength(1);
});

it("keeps a person's message that happens to have no payload", async () => {
  mockListPodMessages.mockResolvedValue([{ id: 'a', content: 'hello', payload: null }]);
  expect(await fetchRecentPodMessages('pod-1', 10)).toHaveLength(1);
});

// F434: a claim line is kept, but it is stored under the agent it is about, so
// it reads as the platform's, with no author an agent could address or mistake
// for itself. A real post by the same agent keeps its author.
it("keeps a claim line as the platform's, not as the agent it is stored under", async () => {
  mockListPodMessages.mockResolvedValue([
    { ...line('task-claimed'), user_id: 'nova-bot', is_bot: true, userId: { _id: 'nova-bot', username: 'nova' } },
    {
      id: 'b', content: 'on it', user_id: 'nova-bot', is_bot: true, userId: { _id: 'nova-bot', username: 'nova' },
    },
  ]);
  const [claim, post] = await fetchRecentPodMessages('pod-1', 10);
  expect(claim).toMatchObject({ author: 'Commonly', authorId: null, authorIsBot: null });
  expect(post).toMatchObject({ author: 'nova', authorId: 'nova-bot', authorIsBot: true });
});
