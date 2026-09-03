// @ts-nocheck
// LLM outages must be visible to callers. These services used to return generic prose
// that looked generated even though the LLM request had failed.

jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({ find: jest.fn() }));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../services/podAssetService', () => ({}));
jest.mock('../../../models/User', () => ({}));
jest.mock('../../../services/digestTemplateService', () => ({
  createDigestPrompt: jest.fn(() => 'digest prompt'),
}));
jest.mock('../../../services/llmService', () => ({ generateText: jest.fn() }));

const { generateText } = require('../../../services/llmService');
const Post = require('../../../models/Post');
const summarizerService = require('../../../services/summarizerService');
const chatSummarizerService = require('../../../services/chatSummarizerService');
const dailyDigestService = require('../../../services/dailyDigestService');

describe('LLM summaries fail closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not fabricate a post summary after an LLM failure', async () => {
    generateText.mockRejectedValueOnce(new Error('LLM unavailable'));

    await expect(summarizerService.generateSummary('A real post', 'posts'))
      .rejects.toThrow('LLM unavailable');
  });

  it('does not cache a generic community overview after an LLM failure', async () => {
    const query = {
      populate: jest.fn(),
      sort: jest.fn(),
      limit: jest.fn(),
      lean: jest.fn(),
    };
    query.populate.mockReturnValue(query);
    query.sort.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.lean.mockResolvedValue([
      { content: 'A real post', tags: [], userId: { username: 'lily' } },
    ]);
    Post.find.mockReturnValueOnce(query);
    generateText.mockRejectedValueOnce(new Error('LLM unavailable'));

    await expect(summarizerService.summarizeAllPosts())
      .rejects.toThrow('LLM unavailable');
  });

  it('does not fabricate chat analytics when enhanced generation returns invalid JSON', async () => {
    generateText.mockResolvedValueOnce('not json');

    await expect(chatSummarizerService.generateEnhancedSummary(
      'A real message',
      'General',
      [{ content: 'A real message', username: 'lily' }],
    )).rejects.toThrow('Enhanced chat summary generation returned invalid JSON');
  });

  it('does not create a generic digest after an LLM failure', async () => {
    generateText.mockRejectedValueOnce(new Error('LLM unavailable'));

    await expect(dailyDigestService.generateDigestContent({}, { username: 'lily' }))
      .rejects.toThrow('LLM unavailable');
  });
});
