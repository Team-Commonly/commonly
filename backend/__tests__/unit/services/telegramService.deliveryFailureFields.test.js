// Row D rests on `sendMessage` handing Telegram's own error_code and description
// to its caller. Until this change they were read only to be logged, and every
// failure arrived as axios's "Request failed with status code 400" — so a
// classifier would have had nothing to classify and a permanent 403 would have
// looked exactly like a transient one. This is the test that keeps the feature
// from silently becoming a no-op.
const axios = require('axios');

jest.mock('axios', () => ({ post: jest.fn() }));

const telegramService = require('../../../services/telegramService');

let consoleError;

beforeEach(() => {
  jest.clearAllMocks();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('sendMessage passes the failure detail through', () => {
  it('returns error_code and description so a call site can classify', async () => {
    axios.post.mockRejectedValueOnce({
      response: { data: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
      message: 'Request failed with status code 400',
    });

    const result = await telegramService.sendMessage('token', '55501', 'hi');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(400);
    expect(result.description).toBe('Bad Request: chat not found');
    // The old field stays: existing callers read it and nothing here decides.
    expect(result.error).toBe('Request failed with status code 400');
  });

  it('returns neither field when the failure carried no Telegram body', async () => {
    axios.post.mockRejectedValueOnce({ message: 'socket hang up' });

    const result = await telegramService.sendMessage('token', '55501', 'hi');

    expect(result.success).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.description).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that would otherwise 400 an HTML send', () => {
    // The bind confirmation names the pod inside parse_mode HTML, so a pod
    // called `A <b>` used to fail the whole send with "can't parse entities".
    expect(telegramService.escapeHtml('A <b> & "c"')).toBe('A &lt;b&gt; &amp; "c"');
    expect(telegramService.escapeHtml('plain')).toBe('plain');
  });
});
