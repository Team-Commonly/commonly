import { describe, expect, it } from '@jest/globals';
import {
  composeRefusalHandoff,
  isContentRefusal,
  refusedItemRef,
  sanitizeHandoffAgent,
} from '../src/lib/content-refusal.js';
import { classifySpawnFailure } from '../src/lib/spawn-retry.js';

const HEAD = '2024f74cbed052cecc3a10e426e8b8460ce3be39';
const OLD_HEAD = '67bff82b3779924db12f59ea2238daac8dcb834d';
const POD_ID = '6a8f6dc7a1dccf2e02f31015';

describe('classifying a content refusal', () => {
  it('reads the measured codex refusal as content_refused', () => {
    const err = new Error('codex turn failed: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.');
    expect(classifySpawnFailure(err)).toBe('content_refused');
    expect(isContentRefusal(err)).toBe(true);
  });

  it('wins over the configuration and quota words a refusal body might also carry', () => {
    expect(classifySpawnFailure(new Error('403 forbidden: this content was flagged'))).toBe('content_refused');
    expect(classifySpawnFailure({ message: 'turn failed', body: { error: 'content_policy_violation' } })).toBe('content_refused');
  });

  it('leaves an ordinary failure that mentions a flag in the runtime class', () => {
    expect(classifySpawnFailure(new Error('feature flag lookup failed'))).toBe('runtime');
    expect(classifySpawnFailure(new Error('flagged as stale, retrying'))).toBe('runtime');
    expect(classifySpawnFailure(new Error('usage limit reached'))).toBe('quota');
  });
});

describe('what the notice may name', () => {
  const event = (content, payload = {}) => ({ payload: { content, messageId: '78195', username: 'lily-shen', ...payload } });

  it('takes the first PR and the full commit id, never a 24-hex pod id', () => {
    const ref = refusedItemRef(event(`[Pod context: pod \`${POD_ID}\`] gate **#2249** at \`${HEAD}\`, on top of #2242`));
    expect(ref).toEqual({ pr: '#2249', heads: [HEAD], messageId: '78195', from: 'lily-shen' });
  });

  it('names every distinct head when a request carries more than one', () => {
    const ref = refusedItemRef(event(`#2249 moved from \`${OLD_HEAD}\` to \`${HEAD}\`; ${HEAD}`));
    expect(ref.heads).toEqual([OLD_HEAD, HEAD]);
  });

  it('drops a sender or message id that is not identifier-shaped', () => {
    const ref = refusedItemRef(event('#2249', { username: 'eve <img src=x>', messageId: '78195; drop' }));
    expect(ref.from).toBe('eveimgsrcx');
    expect(ref.messageId).toBeNull();
  });

  it('composes one line with the hand-off, and a plural line for several', () => {
    const one = { pr: '#2249', heads: [HEAD], messageId: '78195', from: 'lily-shen' };
    expect(composeRefusalHandoff({ items: [one], handoff: 'vera' })).toBe(
      `The model provider refused the content of #2249 at \`${HEAD}\` (message 78195 from lily-shen), `
      + 'so I could not read it and will not retry it. @vera, please take it.',
    );
    const two = { pr: null, heads: [], messageId: '78200', from: null };
    expect(composeRefusalHandoff({ items: [one, two], handoff: 'vera' })).toMatch(
      /^The model provider refused the content of 2 requests: .*; a request \(message 78200\), so I could not read them .* @vera, please take them\.$/,
    );
  });

  it('names no one without a valid hand-off agent, or when mention is off', () => {
    const one = { pr: '#2249', heads: [], messageId: null, from: null };
    expect(composeRefusalHandoff({ items: [one], handoff: null })).toMatch(/#2249 \(no head named\).*It needs another reader\.$/);
    expect(composeRefusalHandoff({ items: [one], handoff: 'vera', mention: false })).not.toContain('@');
    expect(composeRefusalHandoff({ items: [one], handoff: 'vera everyone' })).not.toContain('@');
    expect(sanitizeHandoffAgent('@vera')).toBe('vera');
    expect(sanitizeHandoffAgent('@here please')).toBeNull();
  });
});
