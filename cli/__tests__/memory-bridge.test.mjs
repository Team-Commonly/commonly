/**
 * memory-bridge.test.mjs — ADR-005 §Memory bridge, ADR-003 Phase 2
 *
 * Exercises the two CAP shims the run loop calls around every spawn cycle.
 * Identity (agentName, instanceId) is server-derived from the runtime token,
 * so neither helper takes them — the mocked client just records routes+bodies.
 */

import { jest } from '@jest/globals';
import { readLongTerm, syncBack, SOURCE_RUNTIME } from '../src/lib/memory-bridge.js';

const makeClient = ({ memoryPayload = null, getThrows = false, postThrows = false } = {}) => {
  const get = jest.fn(async () => {
    if (getThrows) throw new Error('404 not found');
    return memoryPayload;
  });
  const post = jest.fn(async () => {
    if (postThrows) throw new Error('500 sync failed');
    return { ok: true };
  });
  return { get, post };
};

describe('readLongTerm', () => {
  test('extracts sections.long_term.content from the envelope', async () => {
    const client = makeClient({
      memoryPayload: {
        content: 'legacy mirror',
        sections: {
          long_term: { content: 'I remember dark mode.', byteSize: 99 },
          soul: { content: 'the agent persona' },
        },
        sourceRuntime: 'local-cli',
        schemaVersion: 2,
      },
    });

    const got = await readLongTerm(client);
    expect(got).toBe('I remember dark mode.');
    expect(client.get).toHaveBeenCalledWith('/api/agents/runtime/memory');
  });

  test('returns empty string when the envelope has no long_term section', async () => {
    const client = makeClient({
      memoryPayload: { sections: { soul: { content: 'persona' } } },
    });
    expect(await readLongTerm(client)).toBe('');
  });

  test('returns empty string on 404 and does NOT surface via onError (fresh agent)', async () => {
    const err404 = Object.assign(new Error('not found'), { status: 404 });
    const client = {
      get: jest.fn(async () => { throw err404; }),
      post: jest.fn(),
    };
    const onError = jest.fn();
    expect(await readLongTerm(client, { onError })).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  test('returns empty string BUT surfaces non-404 errors via onError (auth revoked, 500, etc.)', async () => {
    const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
    const client = {
      get: jest.fn(async () => { throw err401; }),
      post: jest.fn(),
    };
    const onError = jest.fn();
    expect(await readLongTerm(client, { onError })).toBe('');
    expect(onError).toHaveBeenCalledWith(err401);
  });

  test('network-level errors (no status) are swallowed silently — no onError', async () => {
    // A fetch-level failure before any response is comparable to "fresh
    // agent": the spawn should proceed with empty context, no noise.
    const client = {
      get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
      post: jest.fn(),
    };
    const onError = jest.fn();
    expect(await readLongTerm(client, { onError })).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('syncBack', () => {
  test('POSTs patch with sourceRuntime:local-cli and content+visibility only', async () => {
    const client = makeClient();
    const res = await syncBack(client, { summary: 'User prefers dark mode.' });

    expect(res).toEqual({ skipped: false });
    expect(client.post).toHaveBeenCalledWith('/api/agents/runtime/memory/sync', {
      mode: 'patch',
      sourceRuntime: SOURCE_RUNTIME,
      sections: {
        long_term: {
          content: 'User prefers dark mode.',
          visibility: 'private',
        },
      },
    });
  });

  test('never sends byteSize / updatedAt / schemaVersion — server-stamped (ADR-003 invariant #9)', async () => {
    const client = makeClient();
    await syncBack(client, { summary: 'anything' });

    const body = client.post.mock.calls[0][1];
    const longTerm = body.sections.long_term;
    expect(longTerm).toEqual({ content: 'anything', visibility: 'private' });
    expect(longTerm).not.toHaveProperty('byteSize');
    expect(longTerm).not.toHaveProperty('updatedAt');
    expect(body).not.toHaveProperty('schemaVersion');
  });

  test('no-op on empty summary — no POST issued', async () => {
    const client = makeClient();
    const res = await syncBack(client, { summary: '' });
    expect(res).toEqual({ skipped: true });
    expect(client.post).not.toHaveBeenCalled();
  });

  test('no-op when summary field is absent', async () => {
    const client = makeClient();
    const res = await syncBack(client, {});
    expect(res).toEqual({ skipped: true });
    expect(client.post).not.toHaveBeenCalled();
  });

  test('post errors propagate — callers decide whether to swallow', async () => {
    const client = makeClient({ postThrows: true });
    await expect(syncBack(client, { summary: 'x' })).rejects.toThrow(/sync failed/);
  });
});
