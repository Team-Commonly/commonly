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

// TASK-099 site 4. Failing closed is the first half; saying WHICH failure is
// the second. `GET /api/summaries/all-posts` turns a throw from here into a
// 503, and 503 is an instruction to retry — correct for an LLM outage,
// actively wrong for a defect in this method. The route reads `.code`, so the
// tag has to be applied at the throw site, and only at the two causes the
// route's own comment names.
describe('summarizeAllPosts tags the causes that are genuinely unavailability', () => {
  const postsQuery = (result) => {
    const query = {
      populate: jest.fn(),
      sort: jest.fn(),
      limit: jest.fn(),
      lean: jest.fn(),
    };
    query.populate.mockReturnValue(query);
    query.sort.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    if (result instanceof Error) query.lean.mockRejectedValue(result);
    else query.lean.mockResolvedValue(result);
    return query;
  };
  const onePost = [{ content: 'A real post', tags: [], userId: { username: 'lily' } }];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("tags an LLM failure with code 'summary_unavailable'", async () => {
    Post.find.mockReturnValueOnce(postsQuery(onePost));
    generateText.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const err = await summarizerService.summarizeAllPosts().catch((e) => e);

    expect(err.code).toBe('summary_unavailable');
    // The original message survives inside the wrapper: the outer catch still
    // scans it for '429' / 'Resource exhausted' to arm the cooldown, so
    // replacing the text rather than interpolating it would disarm that.
    expect(err.message).toContain('connect ECONNREFUSED');
  });

  it('leaves a datastore failure untagged, so the route reports it as a server error', async () => {
    Post.find.mockReturnValueOnce(postsQuery(new Error('MongoNetworkError: connection 3 to db timed out')));

    const err = await summarizerService.summarizeAllPosts().catch((e) => e);

    expect(err.message).toContain('MongoNetworkError');
    expect(err.code).toBeUndefined();
  });
});
