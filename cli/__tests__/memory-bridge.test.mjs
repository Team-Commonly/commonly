/**
 * memory-bridge.test.mjs — ADR-005 §Memory bridge, ADR-003 Phase 2
 *
 * Exercises the two CAP shims the run loop calls around every spawn cycle.
 * Identity (agentName, instanceId) is server-derived from the runtime token,
 * so neither helper takes them — the mocked client just records routes+bodies.
 */

import { jest } from '@jest/globals';
import { readLongTerm, syncBack, SOURCE_RUNTIME, buildMemoryPreamble } from '../src/lib/memory-bridge.js';

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

  // '' is a claim about STORAGE (nothing is saved). A read failure is a claim
  // about the READ. Collapsing the two made the wrapper assert emptiness on no
  // evidence, and the empty cue then told a seat with a revoked token that it
  // had never saved anything.
  test('returns null, not empty string, when the read FAILS (auth revoked, 500)', async () => {
    const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
    const client = {
      get: jest.fn(async () => { throw err401; }),
      post: jest.fn(),
    };
    const onError = jest.fn();
    expect(await readLongTerm(client, { onError })).toBeNull();
    expect(onError).toHaveBeenCalledWith(err401);
  });

  // The old guard was `err?.status && err.status !== 404`, so a transport
  // failure — which carries no `status` — fell through BOTH the report and the
  // distinction: silent, and indistinguishable from a fresh agent. The backend
  // being unreachable is the loudest condition here, not the quietest.
  test('a transport failure (no status) is unreadable AND reported', async () => {
    const client = {
      get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }),
      post: jest.fn(),
    };
    const onError = jest.fn();
    expect(await readLongTerm(client, { onError })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('404 alone still means genuine absence — empty string, no onError', async () => {
    const err404 = Object.assign(new Error('no row'), { status: 404 });
    const client = {
      get: jest.fn(async () => { throw err404; }),
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


describe('buildMemoryPreamble', () => {
  // The non-empty path is load-bearing for every seat that has content, and
  // this change must not touch it. Asserted byte-for-byte, not by substring.
  it('prepends existing memory verbatim, unchanged', () => {
    expect(buildMemoryPreamble('do the thing', 'remembered state'))
      .toBe('=== Context (your persistent memory) ===\nremembered state\n=== Current turn ===\ndo the thing');
  });

  // The defect this closes: empty memory and no-memory-bridge-at-all used to
  // produce byte-identical prompts, so a seat had no evidence the surface
  // existed. The two must now differ.
  it('says so when nothing has been saved, instead of returning the bare prompt', () => {
    const empty = buildMemoryPreamble('do the thing', '');
    expect(empty).not.toBe('do the thing');
    expect(empty).toContain('(empty');
    expect(empty).toContain('=== Current turn ===\ndo the thing');
  });

  // The cue is worthless if it does not name the section. `readLongTerm` reads
  // ONLY sections.long_term.content, so a seat that saves to `daily` gets a
  // 200 and permanent silence.
  it('names long_term and the exact call, so the write lands where it is read', () => {
    const empty = buildMemoryPreamble('turn', '');
    expect(empty).toContain('long_term');
    expect(empty).toContain('commonly_save_my_memory');
    expect(empty).toMatch(/section:\s*'long_term'/);
  });

  it('adds read-first and save-at-natural-boundary cues only for a fresh session', () => {
    const fresh = buildMemoryPreamble('turn', 'prior gate: waiting', { freshSession: true });
    const resumed = buildMemoryPreamble('turn', 'prior gate: waiting');

    expect(fresh).toContain('=== Fresh session ===');
    expect(fresh).toMatch(/Read the persistent memory context above before acting/i);
    expect(fresh).toMatch(/At a natural end to meaningful work/i);
    expect(fresh).toContain('gates held, decisions pending, and task context, not a transcript');
    expect(fresh).toMatch(/section:\s*'long_term'/);
    expect(resumed).not.toContain('=== Fresh session ===');
    expect(resumed).not.toMatch(/At a natural end to meaningful work/i);
    expect(fresh.indexOf('=== Current turn ===')).toBeLessThan(fresh.indexOf('=== Before this session ends ==='));
  });

  it('does not duplicate the write call when an empty fresh session already carries it', () => {
    const fresh = buildMemoryPreamble('turn', '', { freshSession: true });
    expect(fresh.match(/commonly_save_my_memory/g)).toHaveLength(1);
    expect(fresh).toMatch(/using the long_term write above/i);
  });

  it.each([undefined, ''])('treats %p as empty', (value) => {
    expect(buildMemoryPreamble('turn', value)).toContain('(empty');
  });

  // This case used to be folded in with '' above, which is the conflation the
  // fix removes: `null` is what readLongTerm returns when it could not read at
  // all, and the prompt must not then assert anything about what is stored.
  it('says UNREADABLE for null, and never claims the memory is empty', () => {
    const out = buildMemoryPreamble('do the thing', null);
    expect(out).toContain('unreadable');
    expect(out).not.toContain('(empty');
    expect(out).not.toContain('nothing has ever been saved');
    expect(out).toContain('=== Current turn ===\ndo the thing');
  });

  // The unreadable cue must not carry the write instruction. A seat told to
  // save right now, on the one turn we could not read, is being invited to
  // overwrite state it still holds.
  it('does not prompt a write on the unreadable path', () => {
    expect(buildMemoryPreamble('turn', null)).not.toContain('commonly_save_my_memory');
  });

  it('does not prompt a replacement write on an unreadable fresh session', () => {
    const fresh = buildMemoryPreamble('turn', null, { freshSession: true });
    expect(fresh).toContain('=== Fresh session ===');
    expect(fresh).toMatch(/Do not treat it as empty or write a replacement/i);
    expect(fresh).not.toContain('commonly_save_my_memory');
  });
});
