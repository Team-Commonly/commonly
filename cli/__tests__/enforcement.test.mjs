/**
 * enforcement.test.mjs — ADR-018 D3, wrapper-side deterministic enforcement.
 *
 * Pure-unit coverage of cli/src/lib/enforcement.js:
 *  - classifyTrigger: dmKind first, snapshot isBot second, fail-open third
 *  - createCascadeGovernor: cap, human reset, decay, no double-count on retry
 *  - createClaimKeeper: win/lose/fail-open, renewal loss, release semantics
 *  - splitForChat: short passthrough, boundary preference, fences atomic,
 *    never cuts content
 *  - deliverChatReply: single/split/attach/attach-fallback modes
 *
 * The run-loop wiring of these pieces is covered in run-loop.test.mjs.
 */

import { jest } from '@jest/globals';
import {
  CLAIMABLE_EVENT_TYPES,
  classifyTrigger,
  createCascadeGovernor,
  createClaimKeeper,
  splitForChat,
  deliverChatReply,
} from '../src/lib/enforcement.js';

describe('classifyTrigger', () => {
  const event = (payload) => ({ type: 'chat.mention', payload });

  test('dmKind agent-agent → agent, user-agent → human, regardless of snapshot', () => {
    expect(classifyTrigger(event({ dmKind: 'agent-agent', messageId: 'm1' }), [])).toBe('agent');
    expect(classifyTrigger(event({ dmKind: 'user-agent', messageId: 'm1' }), [])).toBe('human');
  });

  test('falls back to the trigger message isBot flag from the snapshot', () => {
    const messages = [{ _id: 'm1', isBot: true }, { _id: 'm2', isBot: false }];
    expect(classifyTrigger(event({ messageId: 'm1' }), messages)).toBe('agent');
    expect(classifyTrigger(event({ messageId: 'm2' }), messages)).toBe('human');
  });

  test('unknown when the message is absent, unstamped, or there is no snapshot', () => {
    expect(classifyTrigger(event({ messageId: 'gone' }), [{ _id: 'm1', isBot: true }])).toBe('unknown');
    expect(classifyTrigger(event({ messageId: 'm1' }), [{ _id: 'm1' }])).toBe('unknown');
    expect(classifyTrigger(event({ messageId: 'm1' }), null)).toBe('unknown');
    expect(classifyTrigger(event({}), [{ _id: 'm1', isBot: true }])).toBe('unknown');
  });
});

describe('createCascadeGovernor', () => {
  test('admits agent-triggered turns up to the cap, then refuses', () => {
    const gov = createCascadeGovernor({ cap: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(gov.admit('pod-1', 'agent').allowed).toBe(true);
      gov.record('pod-1', 'agent');
    }
    const fourth = gov.admit('pod-1', 'agent');
    expect(fourth.allowed).toBe(false);
    expect(fourth.streak).toBe(3);
  });

  test('human and unknown triggers are always admitted, even at cap', () => {
    const gov = createCascadeGovernor({ cap: 1 });
    gov.record('pod-1', 'agent');
    expect(gov.admit('pod-1', 'agent').allowed).toBe(false);
    expect(gov.admit('pod-1', 'human').allowed).toBe(true);
    expect(gov.admit('pod-1', 'unknown').allowed).toBe(true);
  });

  test('a completed human-triggered turn resets the streak; unknown does not', () => {
    const gov = createCascadeGovernor({ cap: 1 });
    gov.record('pod-1', 'agent');
    gov.record('pod-1', 'unknown'); // neutral: no count, no reset
    expect(gov.admit('pod-1', 'agent').allowed).toBe(false);
    gov.record('pod-1', 'human');
    expect(gov.admit('pod-1', 'agent').allowed).toBe(true);
  });

  test('streaks are per pod', () => {
    const gov = createCascadeGovernor({ cap: 1 });
    gov.record('pod-1', 'agent');
    expect(gov.admit('pod-1', 'agent').allowed).toBe(false);
    expect(gov.admit('pod-2', 'agent').allowed).toBe(true);
  });

  test('the streak decays after resetMs so a damped pod recovers on its own', () => {
    let clock = 0;
    const gov = createCascadeGovernor({ cap: 1, resetMs: 1000, now: () => clock });
    gov.record('pod-1', 'agent');
    expect(gov.admit('pod-1', 'agent').allowed).toBe(false);
    clock = 1001;
    expect(gov.admit('pod-1', 'agent').allowed).toBe(true);
  });

  test('admit alone never increments — a redelivered failed spawn cannot burn the cap', () => {
    const gov = createCascadeGovernor({ cap: 2 });
    for (let i = 0; i < 10; i += 1) gov.admit('pod-1', 'agent');
    expect(gov.admit('pod-1', 'agent').allowed).toBe(true);
  });
});

describe('createClaimKeeper', () => {
  const keeperOpts = (overrides = {}) => ({
    messageId: 'msg-1',
    podId: 'pod-1',
    leaseSeconds: 90,
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => {},
    ...overrides,
  });

  test('acquire wins: POSTs the claim route with podId + lease', async () => {
    const post = jest.fn().mockResolvedValue({ claimed: true, expiresAt: 'later' });
    const keeper = createClaimKeeper({ post }, keeperOpts());
    const res = await keeper.acquire();
    expect(res).toEqual({ claimed: true, expiresAt: 'later' });
    expect(post).toHaveBeenCalledWith(
      '/api/agents/runtime/messages/msg-1/claim',
      { podId: 'pod-1', leaseSeconds: 90 },
    );
  });

  test('acquire loses: reports the holder with instance suffix only when non-default', async () => {
    const post = jest.fn()
      .mockResolvedValueOnce({ claimed: false, claimedBy: 'nova', instanceId: 'default' })
      .mockResolvedValueOnce({ claimed: false, claimedBy: 'claude', instanceId: 'pod-architect' });
    const k1 = createClaimKeeper({ post }, keeperOpts());
    expect((await k1.acquire()).holder).toBe('nova');
    const k2 = createClaimKeeper({ post }, keeperOpts());
    expect((await k2.acquire()).holder).toBe('claude:pod-architect');
  });

  test('acquire fails OPEN on route errors — a missing kernel route must not silence the agent', async () => {
    const post = jest.fn().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    const keeper = createClaimKeeper({ post }, keeperOpts());
    const res = await keeper.acquire();
    expect(res.claimed).toBe(false);
    expect(res.failOpen).toBe(true);
  });

  test('renewal that comes back claimed:false marks the claim lost and stops renewing', async () => {
    let renew = null;
    const clearIntervalImpl = jest.fn();
    const post = jest.fn()
      .mockResolvedValueOnce({ claimed: true }) // acquire
      .mockResolvedValueOnce({ claimed: false, claimedBy: 'nova' }); // renewal
    const keeper = createClaimKeeper({ post }, keeperOpts({
      setIntervalImpl: (fn) => { renew = fn; return 42; },
      clearIntervalImpl,
    }));
    await keeper.acquire();
    keeper.startRenewal();
    expect(keeper.isLost()).toBe(false);
    await renew();
    expect(keeper.isLost()).toBe(true);
    expect(keeper.getHolder()).toBe('nova');
    expect(clearIntervalImpl).toHaveBeenCalledWith(42);
  });

  test('a transient renewal error does NOT mark the claim lost', async () => {
    let renew = null;
    const post = jest.fn()
      .mockResolvedValueOnce({ claimed: true })
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const keeper = createClaimKeeper({ post }, keeperOpts({
      setIntervalImpl: (fn) => { renew = fn; return 42; },
    }));
    await keeper.acquire();
    keeper.startRenewal();
    await renew();
    expect(keeper.isLost()).toBe(false);
  });

  test('release DELETEs only a held, un-lost claim; misses are swallowed', async () => {
    const post = jest.fn().mockResolvedValue({ claimed: true });
    const del = jest.fn().mockRejectedValue(new Error('gone'));
    const keeper = createClaimKeeper({ post, del }, keeperOpts());
    await keeper.acquire();
    await expect(keeper.release()).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith('/api/agents/runtime/messages/msg-1/claim');
  });

  test('release is a no-op when the claim was never acquired or was lost', async () => {
    const del = jest.fn();
    // Never acquired (lost the CAS).
    const k1 = createClaimKeeper(
      { post: jest.fn().mockResolvedValue({ claimed: false, claimedBy: 'nova' }), del },
      keeperOpts(),
    );
    await k1.acquire();
    await k1.release();
    // Acquired then lost mid-turn.
    let renew = null;
    const post = jest.fn()
      .mockResolvedValueOnce({ claimed: true })
      .mockResolvedValueOnce({ claimed: false, claimedBy: 'nova' });
    const k2 = createClaimKeeper({ post, del }, keeperOpts({
      setIntervalImpl: (fn) => { renew = fn; return 1; },
    }));
    await k2.acquire();
    k2.startRenewal();
    await renew();
    await k2.release();
    expect(del).not.toHaveBeenCalled();
  });
});

describe('splitForChat', () => {
  test('short text passes through as one message; empty yields none', () => {
    expect(splitForChat('hello')).toEqual(['hello']);
    expect(splitForChat('  hello  ')).toEqual(['hello']);
    expect(splitForChat('')).toEqual([]);
    expect(splitForChat('   ')).toEqual([]);
  });

  test('splits at paragraph boundaries and packs small paragraphs together', () => {
    const para = (c) => c.repeat(150);
    const text = [para('a'), para('b'), para('c')].join('\n\n'); // 3×150 + separators > 400
    const chunks = splitForChat(text, { limit: 400 });
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(`${para('a')}\n\n${para('b')}`); // 302 chars — packed
    expect(chunks[1]).toBe(para('c'));
  });

  test('never cuts content: rejoined chunks preserve every character', () => {
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${'x'.repeat(120)}.`).join('\n\n');
    const chunks = splitForChat(text, { limit: 400 });
    expect(chunks.join('\n\n')).toBe(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
  });

  test('an oversized paragraph splits at sentence boundaries', () => {
    const sentence = `${'word '.repeat(30)}end.`; // ~154 chars
    const text = [sentence, sentence, sentence, sentence].join(' ');
    const chunks = splitForChat(text, { limit: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400);
      expect(c.endsWith('.')).toBe(true); // sentence-aligned
    }
  });

  test('a single over-limit word (URL) posts whole rather than being cut', () => {
    const url = `https://example.com/${'a'.repeat(500)}`;
    const chunks = splitForChat(`see ${url}`, { limit: 400 });
    expect(chunks.some((c) => c.includes(url))).toBe(true);
  });

  test('fenced code blocks stay whole even when over the limit', () => {
    const fence = `\`\`\`js\n${'const x = 1;\n'.repeat(50)}\`\`\``; // ~656 chars
    const text = `Here is the diff:\n\n${fence}\n\nDone.`;
    const chunks = splitForChat(text, { limit: 400 });
    const fenceChunk = chunks.find((c) => c.includes('const x = 1;'));
    expect(fenceChunk).toContain('```js');
    expect((fenceChunk.match(/```/g) || []).length).toBe(2); // opening + closing in ONE message
  });
});

describe('deliverChatReply', () => {
  const messagesPath = '/api/agents/runtime/pods/pod-1/messages';

  test('short reply posts as a single message', async () => {
    const post = jest.fn().mockResolvedValue({});
    const res = await deliverChatReply({ client: { post }, podId: 'pod-1', text: 'short answer' });
    expect(res).toEqual({ mode: 'single', messages: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(messagesPath, { content: 'short answer' });
  });

  test('a split-sized reply posts its chunks in order', async () => {
    const post = jest.fn().mockResolvedValue({});
    const text = `${'a'.repeat(390)}\n\n${'b'.repeat(390)}`;
    const res = await deliverChatReply({ client: { post }, podId: 'pod-1', text });
    expect(res).toEqual({ mode: 'split', messages: 2 });
    expect(post.mock.calls[0][1].content).toBe('a'.repeat(390));
    expect(post.mock.calls[1][1].content).toBe('b'.repeat(390));
  });

  test('a document-sized reply uploads whole and posts one lead message with the file card', async () => {
    const post = jest.fn().mockResolvedValue({});
    const upload = jest.fn().mockResolvedValue({
      fileName: 'srv-name.md', originalName: 'reply.md', size: 2000, kind: 'document',
    });
    const text = Array.from({ length: 8 }, (_, i) => `Point ${i}: ${'x'.repeat
(300)}`).join('\n\n');
    const res = await deliverChatReply({
      client: { post, upload }, podId: 'pod-1', text, uploadName: 'reply.md',
    });
    expect(res).toEqual({ mode: 'attach', messages: 1 });
    expect(upload).toHaveBeenCalledWith(
      '/api/agents/runtime/pods/pod-1/uploads',
      expect.objectContaining({ fileName: 'reply.md', contentType: 'text/markdown' }),
    );
    // The uploaded file carries the FULL text — nothing is cut.
    expect(upload.mock.calls[0][1].fileBuffer.toString('utf8')).toBe(text);
    expect(post).toHaveBeenCalledTimes(1);
    const { content } = post.mock.calls[0][1];
    expect(content).toContain('Point 0:'); // leads with the reply's own opening
    expect(content).toContain('[[upload:srv-name.md|reply.md|2000|document]]');
  });

  test('upload failure degrades to posting every chunk — flood beats truncation or silence', async () => {
    const post = jest.fn().mockResolvedValue({});
    const upload = jest.fn().mockRejectedValue(new Error('older server'));
    const log = jest.fn();
    const text = Array.from({ length: 6 }, () => 'y'.repeat(350)).join('\n\n');
    const res = await deliverChatReply({
      client: { post, upload }, podId: 'pod-1', text, log,
    });
    expect(res.mode).toBe('split-fallback');
    expect(post).toHaveBeenCalledTimes(res.messages);
    expect(post.mock.calls.map((c) => c[1].content).join('\n\n')).toBe(text);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('older server'));
  });
});

describe('CLAIMABLE_EVENT_TYPES', () => {
  test('covers message-bearing wakes and excludes one-shot / private events', () => {
    expect(CLAIMABLE_EVENT_TYPES.has('chat.mention')).toBe(true);
    expect(CLAIMABLE_EVENT_TYPES.has('message.posted')).toBe(true);
    expect(CLAIMABLE_EVENT_TYPES.has('dm.message')).toBe(true);
    expect(CLAIMABLE_EVENT_TYPES.has('first_contact')).toBe(false);
    expect(CLAIMABLE_EVENT_TYPES.has('heartbeat')).toBe(false);
    expect(CLAIMABLE_EVENT_TYPES.has('agent.ask')).toBe(false);
  });
});
