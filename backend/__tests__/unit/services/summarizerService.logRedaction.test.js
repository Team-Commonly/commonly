// F627: llmService.generateText throws the raw AxiosError when the model is
// pinned (LiteLLM, `Authorization: Bearer <key>` in its config). The summarizer
// logs the failure and rethrows; the log must carry the message, not the request.
const mockGenerateText = jest.fn();
jest.mock('../../../services/llmService', () => ({ generateText: (...args) => mockGenerateText(...args) }));

const summarizerService = require('../../../services/summarizerService');
const { printed, expectNoSecrets } = require('../../utils/fakeAxiosError');

const bearerError = () => {
  const err = new Error('LiteLLM said no');
  err.name = 'AxiosError';
  err.config = {
    url: 'https://llm.example.test/chat?key=fake-query-key',
    headers: { Authorization: 'Bearer fake-secret-key-123' },
  };
  err.response = { status: 401, data: { echo: 'fake-body-secret' }, headers: { 'set-cookie': 'fake-cookie-secret' } };
  return err;
};

describe('summarizerService failure logging (F627)', () => {
  it('generateSummary logs the label and message, never the Bearer key, and still rethrows', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    mockGenerateText.mockRejectedValue(bearerError());
    await expect(summarizerService.generateSummary('content', 'posts')).rejects.toThrow('LiteLLM said no');
    const text = printed(errSpy);
    expect(text).toContain('Error generating summary with LLM:');
    expect(text).toContain('LiteLLM said no');
    expectNoSecrets(text);
    expect(text).not.toContain('Bearer');
    jest.restoreAllMocks();
  });
});
