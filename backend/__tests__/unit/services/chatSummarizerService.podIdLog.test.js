/**
 * An error log names the pod by its id. `%s` prints an object's own properties,
 * so a pod id that arrives as a key-bearing object must not be passed through.
 */
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/podAssetService', () => ({}));
jest.mock('../../../services/llmService', () => ({ generateText: jest.fn() }));

const util = require('util');
const Summary = require('../../../models/Summary');
const ChatSummarizerService = require('../../../services/chatSummarizerService');

describe('ChatSummarizerService error logs', () => {
  const SECRET = 'sk_live_podid_secret_value';
  let errorSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('getLatestPodSummary logs a string id, never an object\'s properties', async () => {
    const failure = new Error('query failed');
    Summary.findOne.mockReturnValue({
      sort: () => ({ lean: () => Promise.reject(failure) }),
    });

    await expect(
      ChatSummarizerService.constructor.getLatestPodSummary({ apiKey: SECRET }),
    ).rejects.toBe(failure);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0];
    args.slice(1).forEach((arg) => expect(typeof arg === 'string' || arg === failure).toBe(true));
    expect(util.format(...args)).not.toContain(SECRET);
  });
});
