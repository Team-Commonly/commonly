const util = require('util');
const {
  describeError, logOutboundFailure, warnOutboundFailure, smtp2goReason,
} = require('../../../utils/safeErrorLog');

const fakeAxiosError = () => {
  const err = new Error('Request failed with status code 401');
  err.name = 'AxiosError';
  err.code = 'ERR_BAD_REQUEST';
  err.config = {
    url: 'https://example.test/api?key=fake-query-key',
    headers: { Authorization: 'Bearer fake-secret-key-123' },
  };
  err.request = { _header: 'Authorization: Bearer fake-secret-key-123' };
  err.response = {
    status: 401,
    data: { echo: 'fake-body-secret' },
    headers: { 'set-cookie': 'fake-cookie-secret' },
  };
  return err;
};

const FAKES = ['fake-secret-key-123', 'fake-query-key', 'fake-body-secret', 'fake-cookie-secret'];

describe('safeErrorLog', () => {
  it('summarises an AxiosError as message, status, code and name only', () => {
    const summary = describeError(fakeAxiosError());
    const { stack, ...rest } = summary;
    expect(rest).toEqual({
      message: 'Request failed with status code 401',
      status: 401,
      code: 'ERR_BAD_REQUEST',
      name: 'AxiosError',
    });
    expect(typeof stack).toBe('string');
    expect(stack).toContain('Request failed with status code 401');
    const text = JSON.stringify(summary);
    FAKES.forEach((fake) => expect(text).not.toContain(fake));
  });

  it('handles strings, null and shapes without a message', () => {
    expect(describeError('boom')).toEqual({ message: 'boom' });
    expect(describeError(null)).toEqual({ message: 'unknown error' });
    expect(describeError({ response: { status: 'x' } })).toEqual({ message: 'unknown error' });
  });

  it('logs the label plus the summary, never the request', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logOutboundFailure('label one:', fakeAxiosError());
    warnOutboundFailure('label two:', fakeAxiosError());
    const calls = [...errSpy.mock.calls, ...warnSpy.mock.calls];
    expect(calls).toHaveLength(2);
    calls.forEach((args) => {
      const text = args.map((a) => util.inspect(a, { depth: 6 })).join(' ');
      FAKES.forEach((fake) => expect(text).not.toContain(fake));
      expect(text).toMatch(/label (one|two):/);
    });
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('keeps the stack, and the stack carries none of the request', () => {
    const err = fakeAxiosError();
    const summary = describeError(err);
    expect(summary.stack).toBe(err.stack);
    FAKES.forEach((fake) => expect(summary.stack).not.toContain(fake));
    expect(JSON.stringify(summary)).not.toContain('fake-secret-key-123');
  });

  it('describeError never throws, even on a hostile getter', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'message', { get() { throw new Error('boom'); } });
    expect(describeError(hostile)).toEqual({ message: 'unknown error' });
  });

  it('passes a caller-chosen extra argument through after the summary', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logOutboundFailure('label:', fakeAxiosError(), { detail: 'provider says bad request' });
    const [format, label, summary, extra] = errSpy.mock.calls[0];
    expect(format).toBe('%s');
    expect(label).toBe('label:');
    expect(summary.status).toBe(401);
    expect(extra).toEqual({ detail: 'provider says bad request' });
    errSpy.mockRestore();
  });

  it('a label with format specifiers prints literally and leaves the summary alone', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logOutboundFailure('pod %o %s failed:', fakeAxiosError());
    const [format, label, summary] = errSpy.mock.calls[0];
    expect(format).toBe('%s');
    expect(label).toBe('pod %o %s failed:');
    expect(summary.status).toBe(401);
    const printed = util.format(...errSpy.mock.calls[0]);
    expect(printed.startsWith('pod %o %s failed: ')).toBe(true);
    expect(printed).toContain('Request failed with status code 401');
    errSpy.mockRestore();
  });

  it('smtp2goReason keeps the error code and text, never the echoed body', () => {
    const err = fakeAxiosError();
    err.response.data = { request_id: 'r', data: { error_code: 'E_ApiResponseCode', error: 'bad', api_key: 'fake-body-secret' } };
    const reason = smtp2goReason(err);
    expect(reason).toEqual({ error_code: 'E_ApiResponseCode', error: 'bad' });
    expect(JSON.stringify(reason)).not.toContain('fake-body-secret');
  });

  it('smtp2goReason is undefined when the response has no provider error, such as an HTML 502', () => {
    const err = fakeAxiosError();
    err.response.data = '<html>502 Bad Gateway</html>';
    expect(smtp2goReason(err)).toBeUndefined();
  });

  it('smtp2goReason is undefined for a network error with no response', () => {
    expect(smtp2goReason(new Error('ECONNREFUSED'))).toBeUndefined();
    expect(smtp2goReason(null)).toBeUndefined();
  });
});
