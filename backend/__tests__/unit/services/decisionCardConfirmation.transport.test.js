jest.mock('axios', () => ({ post: jest.fn(), create: jest.fn() }));
const axios = require('axios');
const { sendMessage } = require('../../../services/telegramService');
const SlackApi = require('../../../services/slackApi');

beforeEach(() => jest.clearAllMocks());

test('Telegram confirmation uses reply_parameters and literal text; ordinary HTML is unchanged', async () => {
  axios.post.mockResolvedValue({ data: { ok: true, result: { message_id: 43 } } });
  await sendMessage('token', 'chat', '✓ Ruled: <label> & value', { replyToMessageId: '42', plainText: true });
  expect(axios.post.mock.calls[0][1]).toEqual({
    chat_id: 'chat', text: '✓ Ruled: <label> & value',
    reply_parameters: { message_id: 42 }, disable_web_page_preview: true,
  });
  await sendMessage('token', 'chat', '<b>agent</b>: ordinary');
  expect(axios.post.mock.calls[1][1]).toEqual({
    chat_id: 'chat', text: '<b>agent</b>: ordinary', parse_mode: 'HTML', disable_web_page_preview: true,
  });
});

test('Slack confirmation targets the parent card without changing ordinary sends', async () => {
  const post = jest.fn(async () => ({ data: { ok: true, ts: '43.001' } }));
  axios.create.mockReturnValue({ post });
  const api = new SlackApi('token');
  await api.postMessage('chat', '✓ Ruled: now', undefined, '42.001');
  expect(post).toHaveBeenCalledWith('/chat.postMessage', {
    channel: 'chat', text: '✓ Ruled: now', blocks: undefined, thread_ts: '42.001',
  });
  await api.postMessage('chat', 'ordinary');
  expect(post.mock.calls[1][1]).not.toHaveProperty('thread_ts');
});
