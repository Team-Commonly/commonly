// A stand-in AxiosError for F627 log-leak tests. Fake values only.
const util = require('util');

const FAKE_SECRETS = ['fake-secret-key-123', 'fake-query-key', 'fake-body-secret', 'fake-cookie-secret'];

const fakeAxiosError = (message = 'Request failed with status code 401') => {
  const err = new Error(message);
  err.name = 'AxiosError';
  err.code = 'ERR_BAD_REQUEST';
  err.config = {
    url: 'https://example.test/api?key=fake-query-key',
    headers: { Authorization: 'Bot fake-secret-key-123' },
  };
  err.request = { _header: 'Authorization: Bot fake-secret-key-123' };
  err.response = {
    status: 401,
    data: { echo: 'fake-body-secret' },
    headers: { 'set-cookie': 'fake-cookie-secret' },
  };
  return err;
};

// Everything the spied console methods were handed, rendered the way node prints it.
const printed = (...spies) => spies
  .flatMap((spy) => spy.mock.calls)
  .map((args) => args.map((a) => util.inspect(a, { depth: 8 })).join(' '))
  .join('\n');

const expectNoSecrets = (text) => {
  FAKE_SECRETS.forEach((fake) => expect(text).not.toContain(fake));
};

module.exports = { fakeAxiosError, printed, expectNoSecrets, FAKE_SECRETS };
