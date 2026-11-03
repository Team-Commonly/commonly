// F78: an embedding provider is called only when it can answer. On prod the
// Gemini key is rejected, so every embed sent pod content to Google and got
// nothing back. EMBEDDING_CONFIG is read at require time, hence isolateModules.
const mockGetGenerativeModel = jest.fn();
const mockGoogleCtor = jest.fn(() => ({ getGenerativeModel: mockGetGenerativeModel }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: mockGoogleCtor }));

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

// The env stays set for the test: the provider is read at require time, the key at call time.
const load = (env) => {
  Object.assign(process.env, env);
  Object.keys(env).filter((k) => env[k] === undefined).forEach((k) => { delete process.env[k]; });
  let svc;
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    const { VectorSearchService } = require('../../../services/vectorSearchService');
    // embed() needs no index, so skip the constructor's per-pod database.
    svc = Object.create(VectorSearchService.prototype);
  });
  return svc;
};

describe('vectorSearchService.embed provider gate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('EMBEDDING_PROVIDER=none makes no call and returns null quietly', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = load({ EMBEDDING_PROVIDER: 'none', GEMINI_API_KEY: 'k' });
    await expect(svc.embed('pod content')).resolves.toBeNull();
    expect(mockGoogleCtor).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the gemini provider without a key makes no call', async () => {
    const svc = load({ EMBEDDING_PROVIDER: 'gemini', GEMINI_API_KEY: undefined });
    await expect(svc.embed('pod content')).resolves.toBeNull();
    expect(mockGoogleCtor).not.toHaveBeenCalled();
  });

  it('the gemini provider with a key still embeds', async () => {
    mockGetGenerativeModel.mockReturnValue({ embedContent: async () => ({ embedding: { values: [0.1, 0.2] } }) });
    const svc = load({ EMBEDDING_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    await expect(svc.embed('pod content')).resolves.toEqual([0.1, 0.2]);
    expect(mockGoogleCtor).toHaveBeenCalledWith('k');
  });
});
