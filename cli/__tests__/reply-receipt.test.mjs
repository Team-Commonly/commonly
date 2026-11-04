// D245 item 4: the receipt the wrapper reports with a reply. Self-reported by
// design; the server stamps and bounds it (backend/services/byoReceipt.ts).
import { jest } from '@jest/globals';
import { buildReplyReceipt, claudeRunStats } from '../src/lib/reply-receipt.js';
import { deliverChatReply } from '../src/lib/enforcement.js';

const line = (event) => JSON.stringify(event);

describe('claudeRunStats', () => {
  test('reads the model, the turn count and the tools used, in first-use order', () => {
    const stdout = [
      line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash' }, { type: 'tool_use', id: 't3', name: 'Read' }] } }),
      'not json',
      line({ type: 'result', num_turns: 4, result: 'Done.' }),
    ].join('\n');
    expect(claudeRunStats(stdout)).toEqual({ model: 'claude-opus-5-5', turns: 4, tools: ['Read', 'Bash'] });
  });

  test('reports nothing it did not see', () => {
    expect(claudeRunStats('')).toEqual({});
    expect(claudeRunStats(line({ type: 'result', result: 'x' }))).toEqual({});
  });
});

describe('buildReplyReceipt', () => {
  test('carries the adapter, what the adapter saw, and the measured duration', () => {
    expect(buildReplyReceipt({
      adapterName: 'claude', stats: { model: 'claude-opus-5-5', turns: 2, tools: ['Read'] }, durationMs: 1234.6,
    })).toEqual({
      adapter: 'claude', model: 'claude-opus-5-5', turns: 2, tools: ['Read'], durationMs: 1235,
    });
  });

  test('an adapter that reports no stats still gives adapter and duration', () => {
    expect(buildReplyReceipt({ adapterName: 'codex', durationMs: 900 })).toEqual({ adapter: 'codex', durationMs: 900 });
  });

  test('drops values the server would refuse instead of sending them', () => {
    expect(buildReplyReceipt({
      adapterName: 'claude', stats: { model: '', turns: -1, tools: 'Read' }, durationMs: Number.NaN,
    })).toEqual({ adapter: 'claude' });
  });

  test('no adapter name means no receipt', () => {
    expect(buildReplyReceipt({ durationMs: 5 })).toBeNull();
  });
});

describe('deliverChatReply with a receipt', () => {
  const messagesPath = '/api/agents/runtime/pods/pod-1/messages';
  const receipt = { adapter: 'claude', durationMs: 900 };

  test('a single reply carries it', async () => {
    const post = jest.fn().mockResolvedValue({});
    await deliverChatReply({ client: { post }, podId: 'pod-1', text: 'short answer', receipt });
    expect(post).toHaveBeenCalledWith(messagesPath, { content: 'short answer', receipt });
  });

  test('a split reply carries it on the first message only', async () => {
    const post = jest.fn().mockResolvedValue({});
    const text = `${'a'.repeat(300)}\n\n${'b'.repeat(300)}`;
    await deliverChatReply({ client: { post }, podId: 'pod-1', text, receipt });
    expect(post.mock.calls.length).toBeGreaterThan(1);
    expect(post.mock.calls[0][1].receipt).toEqual(receipt);
    post.mock.calls.slice(1).forEach(([, body]) => expect(body).not.toHaveProperty('receipt'));
  });

  test('when the first rung fails before anything posts, the next delivered message carries it', async () => {
    const post = jest.fn()
      .mockRejectedValueOnce(new Error('headline failed'))
      .mockResolvedValue({});
    const upload = jest.fn().mockResolvedValue({ fileName: 'f.md', originalName: 'reply.md', size: 10, kind: 'document' });
    const text = Array.from({ length: 6 }, (_, i) => `${String(i).repeat(300)}`).join('\n\n');
    await deliverChatReply({ client: { post, upload }, podId: 'pod-1', text, receipt });
    expect(post.mock.calls[0][1].receipt).toEqual(receipt);
    expect(post.mock.calls[1][1].receipt).toEqual(receipt);
  });

  test('without a receipt the body is unchanged', async () => {
    const post = jest.fn().mockResolvedValue({});
    await deliverChatReply({ client: { post }, podId: 'pod-1', text: 'short answer' });
    expect(post).toHaveBeenCalledWith(messagesPath, { content: 'short answer' });
  });
});
