/**
 * A card's stored text never changes, so context reads take the outcome from its
 * payload. Without this Scout told someone a declined card was still waiting.
 */
const mockListPodMessages = jest.fn();
jest.mock('../../../repositories/messageRepository', () => ({
  listPodMessages: (...args) => mockListPodMessages(...args),
}));

const { fetchRecentPodMessages } = require('../../../services/nativeRuntimeService');

const card = (payload) => ({
  id: '1',
  content: '[approval needed] Connect your Claude Code',
  payload: { kind: 'approval-card', ...payload },
});
const contentOf = async (row) => {
  mockListPodMessages.mockResolvedValueOnce([row]);
  const [message] = await fetchRecentPodMessages('pod-1', 10);
  return message.content;
};

describe('fetchRecentPodMessages reads a card by its outcome', () => {
  test.each([
    ['declined', { status: 'resolved', decision: 'declined' }, '[approval declined] Connect your Claude Code'],
    ['approved', { status: 'resolved', decision: 'approved' }, '[approval approved] Connect your Claude Code'],
    ['expired', { status: 'expired' }, '[approval expired] Connect your Claude Code'],
    ['closed by the sweep', { status: 'moot' }, '[approval closed] Connect your Claude Code'],
    ['approved, then the action threw', { status: 'resolved', decision: 'approved', executionError: 'boom' },
      '[approval failed] Connect your Claude Code'],
    ['approved, then the call failed', { status: 'resolved', decision: 'approved', toolCallEnding: 'failed' },
      '[approval failed] Connect your Claude Code'],
    ['approved, then the call was refused', { status: 'resolved', decision: 'approved', toolCallEnding: 'refused' },
      '[approval failed] Connect your Claude Code'],
    ['approved, and it may have run',
      { status: 'resolved', decision: 'approved', toolCallEnding: 'failed', toolCallCode: 'approval_outcome_unknown' },
      '[approval outcome unknown] Connect your Claude Code'],
    ['waiting', { status: 'flagged' }, '[approval needed] Connect your Claude Code'],
    ['no status on an old row', {}, '[approval needed] Connect your Claude Code'],
  ])('%s', async (_name, payload, expected) => {
    await expect(contentOf(card(payload))).resolves.toBe(expected);
  });

  test('a person quoting the words keeps them', async () => {
    await expect(contentOf({ id: '2', content: '[approval needed] what does this mean?' }))
      .resolves.toBe('[approval needed] what does this mean?');
  });
});
