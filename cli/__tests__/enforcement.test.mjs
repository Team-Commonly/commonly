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
  ADDRESSED_EVENT_TYPES,
  CASCADE_DEFAULTS,
  CASCADE_ENV_VARS,
  CLAIMABLE_EVENT_TYPES,
  MENTION_EVENT_TYPES,
  classifyTrigger,
  createCascadeGovernor,
  createClaimHandicap,
  createClaimKeeper,
  peerHoldsFrame,
  resolveCascadeSettings,
  splitForChat,
  deliverChatReply,
} from '../src/lib/enforcement.js';

describe('classifyTrigger', () => {
  const event = (payload) => ({ type: 'chat.mention', payload });

  test('dmKind agent-agent → agent, user-agent → human, regardless of snapshot', () => {
    expect(classifyTrigger(event({ dmKind: 'agent-agent', messageId: 'm1' }), [])).toBe('agent');
    expect(classifyTrigger(event({ dmKind: 'user-agent', messageId: 'm1' }), [])).toBe('human');
  });

  // ADR-024 D1 board wakes carry `dmKind` and NO `messageId` — deliberately, so
  // every opted-in seat looks and the per-task claim CAS arbitrates
  // (taskEventService.ts:237). That backend comment is only safe because the
  // dmKind branches sit ABOVE the messageId check here. Move the messageId
  // check up, or add an early `if (!p.messageId) return 'unknown'`, and every
  // board wake classifies 'unknown' — which by design neither counts toward the
  // cascade cap nor resets it, so the cap silently stops engaging and the
  // 156-wake sweep this governor exists to bound comes back.
  //
  // The suite already asserted dmKind pricing and messageId fallback, but every
  // dmKind case supplied a messageId and every messageId case omitted dmKind —
  // so the one combination the backend actually emits was never exercised, and
  // both reorderings passed 107/107.
  test('prices by dmKind with NO messageId — the board-wake shape', () => {
    expect(classifyTrigger(event({ dmKind: 'agent-agent' }), [])).toBe('agent');
    expect(classifyTrigger(event({ dmKind: 'user-agent' }), [])).toBe('human');
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

// #989: the governor was documented as a static ceiling released by pod
// silence. It is neither. These pin the shape the docstring now claims, so a
// future edit that makes refusals record (or that shares state across pods)
// fails here instead of quietly re-arming the wrong mental model.
describe('classifyTrigger — the kernel branch (#1044)', () => {
  it('classifies a kernel-found wake as kernel, before any dmKind reading', () => {
    // triggerAuthor is the honest field (#1018) and wins where both appear.
    expect(classifyTrigger({ payload: { triggerAuthor: 'kernel' } }, [])).toBe('kernel');
    expect(classifyTrigger(
      { payload: { triggerAuthor: 'kernel', dmKind: 'agent-agent' } }, [],
    )).toBe('kernel');
  });

  it('a kernel wake neither counts toward the streak nor clears it', () => {
    // Priced as agent it silences seats exactly when the board is busiest;
    // priced as human it clears the brake on unrelated cascades. Neutral,
    // by design rather than by fallback.
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 0 });
    gov.record('pod', 'agent');
    expect(gov.admit('pod', 'agent', 'message.posted').allowed).toBe(false);

    gov.record('pod', 'kernel');
    // Still capped: the kernel turn did not reset the brake...
    expect(gov.admit('pod', 'agent', 'message.posted').allowed).toBe(false);
    // ...and the kernel wake itself is always admitted.
    expect(gov.admit('pod', 'kernel', 'message.posted').allowed).toBe(true);
  });

  it('an old-CLI payload shape (no triggerAuthor, no messageId) stays unknown-neutral', () => {
    // Graceful degradation: a fleet that predates the branch prices kernel
    // wakes as unknown, which is also neutral — never silencing.
    expect(classifyTrigger({ payload: { boardWake: true, content: 'x' } }, [])).toBe('unknown');
  });
});

describe('cascade governor — token-bucket shape', () => {
  // Mirrors the run loop: agent.js returns on a refusal WITHOUT calling
  // record(), so only admitted turns move `lastAgentTurnAt`.
  const admitsPerHour = (intervalMs, pods = ['pod-1']) => {
    let clock = 0;
    const gov = createCascadeGovernor({ now: () => clock });
    let admits = 0;
    for (let i = 0; clock <= 3600_000; i += 1) {
      const pod = pods[i % pods.length];
      if (gov.admit(pod, 'agent', 'message.posted').allowed) {
        admits += 1;
        gov.record(pod, 'agent');
      }
      clock += intervalMs;
    }
    return admits;
  };

  test('a capped seat self-releases every window however loud the pod is', () => {
    // cap 3 per 10-min window = 18/hr, and it does not climb as arrivals get
    // faster: the burst is absorbed, not admitted.
    expect(admitsPerHour(30_000)).toBe(18);
    expect(admitsPerHour(1_000)).toBe(18);
  });

  test('below saturation the arrival rate binds, not the cap', () => {
    expect(admitsPerHour(600_000)).toBe(6);
    expect(admitsPerHour(60_000)).toBe(15);
  });

  test('the ceiling is per pod — N pods hold N independent buckets', () => {
    expect(admitsPerHour(1_000, ['pod-1'])).toBe(18);
    expect(admitsPerHour(1_000, ['pod-1', 'pod-2'])).toBe(36);
    expect(admitsPerHour(1_000, ['pod-1', 'pod-2', 'pod-3'])).toBe(54);
  });
});

describe('cascade governor — addressed grace', () => {
  const burn = (gov, n, type) => {
    for (let i = 0; i < n; i += 1) {
      gov.admit('pod', 'agent', type);
      gov.record('pod', 'agent');
    }
  };

  it('refuses a broadcast at the cap but still admits a direct mention', () => {
    const gov = createCascadeGovernor({ cap: 3, addressedGrace: 2 });
    burn(gov, 3, 'message.posted');

    expect(gov.admit('pod', 'agent', 'message.posted').allowed).toBe(false);
    expect(gov.admit('pod', 'agent', 'chat.mention').allowed).toBe(true);
  });

  it('marks the admission so the caller can say the grace was spent', () => {
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 1 });
    expect(gov.admit('pod', 'agent', 'chat.mention').addressed).toBe(true);
    expect(gov.admit('pod', 'agent', 'message.posted').addressed).toBe(false);
  });

  it('does not report a grace it never granted to a legacy direct-address event, at addressedGrace 0', () => {
    // The refusal log is the one line an operator reads to understand why a
    // seat went quiet. Keyed on `addressed` alone it announced "(addressed
    // grace also spent)" on a grace=0 seat — asserting a grace that does not
    // exist, three screens under a boot line that says grace=0. The event is
    // still addressed; nothing was granted for it. Agent-DM wakes use
    // chat.mention, but the legacy dm.message vocabulary remains supported.
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 0 });
    const admission = gov.admit('pod', 'agent', 'dm.message');
    expect(admission.addressed).toBe(true);
    expect(admission.graceApplied).toBe(false);
    // And the limit really is the plain cap — the message was the only defect.
    gov.record('pod', 'agent');
    expect(gov.admit('pod', 'agent', 'dm.message').allowed).toBe(false);
  });

  it('exempts only kernel-dampened non-DM mentions; DM-backed mentions stay in the streak', () => {
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 0 });
    gov.record('pod', 'agent');

    // The kernel's bot-to-bot dampener owns these two types. A named seat must
    // stay reachable after broadcasts fill this local budget.
    expect(gov.admit('pod', 'agent', 'chat.mention').allowed).toBe(true);
    expect(gov.admit('pod', 'agent', 'thread.mention').allowed).toBe(true);

    // Agent DMs also use chat.mention, but dmKind identifies the other
    // producer. They must remain locally bounded; otherwise a type-only
    // exemption opens a second unbounded bot-to-bot loop.
    expect(gov.admit('pod', 'agent', 'chat.mention', { dmKind: 'agent-agent' }).allowed).toBe(false);

    // dm.message is legacy direct-address vocabulary, not in the kernel
    // mention budget, so it remains bounded locally. Broadcasts do too.
    expect(gov.admit('pod', 'agent', 'dm.message').allowed).toBe(false);
    expect(gov.admit('pod', 'agent', 'message.posted').allowed).toBe(false);
  });

  it('records a completed mention, so it spends broadcast liveness', () => {
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 0 });
    gov.record('pod', 'agent');

    expect(gov.admit('pod', 'agent', 'chat.mention').allowed).toBe(true);
    // Mirrors agent.js: exemption only changes admit(); a completed turn still
    // reaches record(). The following broadcast remains capped at the new
    // streak rather than acquiring an extra unmetered pass.
    gov.record('pod', 'agent');
    expect(gov.admit('pod', 'agent', 'message.posted')).toMatchObject({
      allowed: false,
      streak: 2,
    });
  });

  it('a human turn still clears the streak for addressed and broadcast alike', () => {
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 1 });
    burn(gov, 2, 'dm.message');
    expect(gov.admit('pod', 'agent', 'dm.message').allowed).toBe(false);

    gov.record('pod', 'human');
    expect(gov.admit('pod', 'agent', 'message.posted').allowed).toBe(true);
  });

  it('an unknown event type is treated as a broadcast, not as addressed', () => {
    const gov = createCascadeGovernor({ cap: 1, addressedGrace: 5 });
    burn(gov, 1, 'message.posted');
    expect(gov.admit('pod', 'agent', undefined).allowed).toBe(false);
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

  test('a document-sized single fence attaches — it cannot ride the single-post branch (msg 53018)', async () => {
    const post = jest.fn().mockResolvedValue({});
    const upload = jest.fn().mockResolvedValue({
      fileName: 'srv.md', originalName: 'reply.md', size: 950, kind: 'document',
    });
    const fence = `\`\`\`js\n${'const x = 1;\n'.repeat(72)}\`\`\``; // ~945 chars, one atomic chunk
    const res = await deliverChatReply({
      client: { post, upload }, podId: 'pod-1', text: fence, uploadName: 'reply.md',
    });
    expect(res.mode).toBe('attach');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    const { content } = post.mock.calls[0][1];
    // The lead must not be the giant fence itself — generic line + file card.
    expect(content).toContain('attached in full');
    expect(content).toContain('[[upload:srv.md');
    expect(content.length).toBeLessThan(500);
  });

  test('the contract gray zone: a 400-800 char indivisible fence posts as ONE message', async () => {
    // "Aim under 400 … NEVER hit that by cutting content" + "over ~800 of one
    // indivisible thing → attach": between those lines, an unsplittable fence
    // is a sanctioned single message — splitting would break its rendering,
    // attaching a snippet-sized block would be worse UX than one long post.
    const post = jest.fn().mockResolvedValue({});
    const upload = jest.fn();
    const fence = `\`\`\`js\n${'const x = 1;\n'.repeat(50)}\`\`\``; // ~660 chars
    const res = await deliverChatReply({
      client: { post, upload }, podId: 'pod-1', text: fence,
    });
    expect(res.mode).toBe('single');
    expect(upload).not.toHaveBeenCalled();
  });

  test('an oversized fence inside a small split also forces the attach path', async () => {
    const post = jest.fn().mockResolvedValue({});
    const upload = jest.fn().mockResolvedValue({
      fileName: 'srv.md', originalName: 'reply.md', size: 1200, kind: 'document',
    });
    const fence = `\`\`\`js\n${'const x = 1;\n'.repeat(70)}\`\`\``; // ~920 chars atomic
    const text = `Here is the diff:\n\n${fence}`;
    const res = await deliverChatReply({
      client: { post, upload }, podId: 'pod-1', text, uploadName: 'reply.md',
    });
    expect(res.mode).toBe('attach');
    // The prose opening is under the limit, so it stays the lead.
    expect(post.mock.calls[0][1].content).toContain('Here is the diff:');
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

describe('createClaimHandicap', () => {
  test('no handicap before any win; a win adds a jittered delay to the NEXT race', () => {
    let clock = 0;
    const handicap = createClaimHandicap({
      delayMs: 3000, jitterMs: 1000, now: () => clock, random: () => 0.5,
    });
    expect(handicap.yieldDelayMs('pod-1')).toBe(0);
    handicap.recordWin('pod-1');
    expect(handicap.yieldDelayMs('pod-1')).toBe(3500);
    expect(handicap.yieldDelayMs('pod-2')).toBe(0); // per pod
  });

  test('a loss clears the handicap — you are only the monopolist while winning', () => {
    const handicap = createClaimHandicap({ delayMs: 3000, jitterMs: 0 });
    handicap.recordWin('pod-1');
    handicap.recordLoss('pod-1');
    expect(handicap.yieldDelayMs('pod-1')).toBe(0);
  });

  test('the handicap decays after windowMs of quiet', () => {
    let clock = 0;
    const handicap = createClaimHandicap({
      delayMs: 3000, jitterMs: 0, windowMs: 1000, now: () => clock,
    });
    handicap.recordWin('pod-1');
    clock = 1001;
    expect(handicap.yieldDelayMs('pod-1')).toBe(0);
  });
});

describe('peerHoldsFrame / ADDRESSED_EVENT_TYPES', () => {
  test('addressed types are the human-chose-you set; broadcast wakes are not in it', () => {
    expect(ADDRESSED_EVENT_TYPES.has('chat.mention')).toBe(true);
    expect(ADDRESSED_EVENT_TYPES.has('thread.mention')).toBe(true);
    expect(ADDRESSED_EVENT_TYPES.has('dm.message')).toBe(true);
    expect(ADDRESSED_EVENT_TYPES.has('message.posted')).toBe(false);
  });

  test('the peer frame names the holder, the message, and the raised bar', () => {
    const frame = peerHoldsFrame('nova', '52997');
    expect(frame).toContain('@nova');
    expect(frame).toContain('52997');
    expect(frame).toContain('materially different');
    expect(frame).toContain('NO_REPLY');
  });
});

describe('MENTION_EVENT_TYPES', () => {
  test('contains only the two producer-dampened mention types, not DMs', () => {
    expect([...MENTION_EVENT_TYPES]).toEqual(['chat.mention', 'thread.mention']);
    expect(MENTION_EVENT_TYPES.has('dm.message')).toBe(false);
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


describe('resolveCascadeSettings', () => {
  // Pass an explicit empty env everywhere: reading the real process.env would
  // make these pass or fail depending on the shell that ran them, which is the
  // one thing a config test must not do.
  const noEnv = {};
  const silent = () => {};

  test('with nothing set, resolves the shipped defaults', () => {
    expect(resolveCascadeSettings({ env: noEnv, warn: silent })).toEqual({
      cap: 3,
      addressedGrace: 2,
      resetMs: 10 * 60 * 1000,
    });
    // Pinned against CASCADE_DEFAULTS too, so a default changed in one place
    // and not the other is a failure rather than a silent drift.
    expect(resolveCascadeSettings({ env: noEnv, warn: silent })).toEqual({ ...CASCADE_DEFAULTS });
  });

  test('env vars are read, and an override outranks them', () => {
    const env = {
      [CASCADE_ENV_VARS.cap]: '5',
      [CASCADE_ENV_VARS.addressedGrace]: '0',
      [CASCADE_ENV_VARS.resetMs]: '60000',
    };
    expect(resolveCascadeSettings({ env, warn: silent })).toEqual({
      cap: 5, addressedGrace: 0, resetMs: 60000,
    });
    expect(resolveCascadeSettings({ env, overrides: { cap: 9 }, warn: silent }).cap).toBe(9);
  });

  test('zero is honoured, not treated as absent', () => {
    // Legacy direct-address events remain on the configurable grace path. A
    // `|| default` style resolver would silently ignore 0 and admit one more.
    const settings = resolveCascadeSettings({
      env: { [CASCADE_ENV_VARS.addressedGrace]: '0' }, warn: silent,
    });
    expect(settings.addressedGrace).toBe(0);
    const governor = createCascadeGovernor({ ...settings, now: () => 1000 });
    governor.record('pod', 'agent');
    governor.record('pod', 'agent');
    governor.record('pod', 'agent');
    expect(governor.admit('pod', 'agent', 'dm.message').allowed).toBe(false);
  });

  test('a garbage override falls back and warns, exactly like a garbage env var', () => {
    // The regression this exists for: overrides used to skip validation, so
    // `--cascade-cap abc` reached the governor as NaN. `streak < NaN` is false
    // for every streak, so the seat silently refused every agent turn forever.
    const warnings = [];
    const settings = resolveCascadeSettings({
      env: noEnv,
      overrides: { cap: Number('abc') },
      warn: (m) => warnings.push(m),
    });
    expect(settings.cap).toBe(CASCADE_DEFAULTS.cap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('--cascade-cap');

    // And the value that reaches the governor still admits a fresh pod, which
    // is the behaviour NaN destroyed.
    expect(createCascadeGovernor(settings).admit('pod', 'agent', 'chat.mention').allowed).toBe(true);
  });

  test('out-of-range and non-integer values fall back, naming their source', () => {
    const warnings = [];
    const settings = resolveCascadeSettings({
      env: {
        [CASCADE_ENV_VARS.cap]: '-1',
        [CASCADE_ENV_VARS.addressedGrace]: '1.5',
        [CASCADE_ENV_VARS.resetMs]: '10',
      },
      warn: (m) => warnings.push(m),
    });
    expect(settings).toEqual({ ...CASCADE_DEFAULTS });
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain(CASCADE_ENV_VARS.cap);
    expect(warnings.join('\n')).toContain(CASCADE_ENV_VARS.addressedGrace);
    expect(warnings.join('\n')).toContain(CASCADE_ENV_VARS.resetMs);
  });

  test('an empty-string env var is absence, not a zero', () => {
    // Unset and exported-empty look identical in a shell launch script; the
    // second must not silently become cap=0 and mute the seat.
    expect(resolveCascadeSettings({
      env: { [CASCADE_ENV_VARS.cap]: '  ' }, warn: silent,
    }).cap).toBe(CASCADE_DEFAULTS.cap);
  });
});
