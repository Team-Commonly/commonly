// F627: the LiteLLM embedding call sends `Authorization: Bearer <key>`; when it
// fails, the log carries the message and status, never the AxiosError config.
jest.mock('axios');

const axios = require('axios');
const { fakeAxiosError, printed, expectNoSecrets } = require('../../utils/fakeAxiosError');

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('vectorSearchService embedding failure logging (F627)', () => {
  it('embed logs the label and message, not the request, and returns null', async () => {
    Object.assign(process.env, {
      EMBEDDING_PROVIDER: 'litellm',
      LITELLM_BASE_URL: 'https://litellm.test',
      LITELLM_API_KEY: 'fake-secret-key-123',
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.post.mockRejectedValue(fakeAxiosError('embedding backend down'));
    let svc;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      const { VectorSearchService } = require('../../../services/vectorSearchService');
      svc = Object.create(VectorSearchService.prototype);
    });
    await expect(svc.embed('pod content')).resolves.toBeNull();
    const text = printed(errSpy);
    expect(text).toContain('Embedding error:');
    expect(text).toContain('embedding backend down');
    expectNoSecrets(text);
    errSpy.mockRestore();
  });
});
