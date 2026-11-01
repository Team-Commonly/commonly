/**
 * TASK-539: GroupMe takes the access token as a query parameter, so a failed
 * request's axios error carries it in `config.params` and the request URL.
 * fetchMessages rethrows the status only, so a caller that logs the error object
 * never logs the token.
 */
const util = require('util');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { fetchMessages } = require('../../../services/groupmeService');

const TOKEN = 'groupme-secret-token';

const axiosError = (status) => Object.assign(new Error(status
  ? `Request failed with status code ${status}`
  : 'socket hang up'), {
  config: { params: { token: TOKEN }, url: `https://api.groupme.com/v3/groups/g1/messages?token=${TOKEN}` },
  request: { path: `/v3/groups/g1/messages?token=${TOKEN}` },
  ...(status ? { response: { status, config: { params: { token: TOKEN } } } } : {}),
});

describe('groupmeService.fetchMessages error shape', () => {
  beforeEach(() => axios.get.mockReset());

  it('rethrows an HTTP failure with its status and without the token', async () => {
    axios.get.mockRejectedValue(axiosError(401));

    const err = await fetchMessages({ groupId: 'g1', accessToken: TOKEN }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.message).toBe('GroupMe request failed with status 401');
    expect(util.inspect(err, { depth: 10 })).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('rethrows a network failure without the token', async () => {
    axios.get.mockRejectedValue(axiosError(undefined));

    const err = await fetchMessages({ groupId: 'g1', accessToken: TOKEN }).catch((e) => e);

    expect(err.message).toBe('GroupMe request failed');
    expect(err.status).toBeUndefined();
    expect(util.inspect(err, { depth: 10 })).not.toContain(TOKEN);
  });

  it('still sends the token to GroupMe and normalizes a success', async () => {
    axios.get.mockResolvedValue({ data: { response: { messages: [{ id: 'm1', name: 'A', text: 'hi' }] } } });

    const messages = await fetchMessages({ groupId: 'g1', accessToken: TOKEN, limit: 5 });

    expect(axios.get.mock.calls[0][1]).toEqual({ params: { token: TOKEN, limit: 5 } });
    expect(messages).toEqual([expect.objectContaining({ id: 'm1', authorName: 'A', content: 'hi' })]);
  });
});
