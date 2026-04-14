// @ts-nocheck
// ADR-003 Phase 1: parser logic that maps legacy v1 `content` blobs into
// v2 `sections`. Pure functions — no DB required.

const {
  parseContentIntoSections,
  buildSectionsFromLegacyContent,
  mirrorContentFromSections,
  stampSectionsForWrite,
  mergePatchSections,
  computeSyncDedupKey,
  isValidYMD,
} = require('../../../services/agentMemoryService');

describe('parseContentIntoSections', () => {
  it('returns empty sections on empty input', () => {
    expect(parseContentIntoSections('')).toEqual({ long_term: '', dedup_state: '' });
    expect(parseContentIntoSections('   \n\n  ')).toEqual({ long_term: '', dedup_state: '' });
  });

  it('puts content with no ## headers entirely in long_term', () => {
    const r = parseContentIntoSections('Just a preamble with no headers.');
    expect(r.long_term).toBe('Just a preamble with no headers.');
    expect(r.dedup_state).toBe('');
  });

  it('extracts ## Commented into dedup_state', () => {
    const src = [
      '# MEMORY.md',
      'Durable stuff.',
      '## Commented',
      '{"abc": 3}',
    ].join('\n');
    const r = parseContentIntoSections(src);
    expect(r.dedup_state).toContain('## Commented');
    expect(r.dedup_state).toContain('{"abc": 3}');
    expect(r.long_term).toContain('# MEMORY.md');
    expect(r.long_term).toContain('Durable stuff.');
    expect(r.long_term).not.toContain('## Commented');
  });

  it('extracts all known dedup headers together', () => {
    const src = [
      '## Commented',
      '{}',
      '## Replied',
      '[]',
      '## RepliedMsgs',
      '[]',
      '## PodVisits',
      '{}',
      '## StaleRevivalAt',
      '{}',
      '## NotDedup',
      'keep me',
    ].join('\n');
    const r = parseContentIntoSections(src);
    for (const h of ['Commented', 'Replied', 'RepliedMsgs', 'PodVisits', 'StaleRevivalAt']) {
      expect(r.dedup_state).toContain(`## ${h}`);
    }
    expect(r.dedup_state).not.toContain('## NotDedup');
    expect(r.long_term).toContain('## NotDedup');
    expect(r.long_term).toContain('keep me');
  });

  it('is case-insensitive on dedup header matching', () => {
    const src = '## commented\nfoo\n## Replied\nbar';
    const r = parseContentIntoSections(src);
    expect(r.dedup_state).toContain('commented');
    expect(r.dedup_state).toContain('Replied');
    expect(r.long_term).toBe('');
  });

  it('ignores unknown headers and leaves them in long_term', () => {
    const src = '## Pods\n{}\n## ScannedRepos\n[]';
    const r = parseContentIntoSections(src);
    expect(r.long_term).toContain('## Pods');
    expect(r.long_term).toContain('## ScannedRepos');
    expect(r.dedup_state).toBe('');
  });

  it('keeps preamble before the first ## header in long_term', () => {
    const src = 'Preamble line.\n\n## Commented\n{}';
    const r = parseContentIntoSections(src);
    expect(r.long_term).toContain('Preamble line.');
    expect(r.dedup_state).toContain('## Commented');
  });

  it('re-parsing the already-extracted long_term produces no dedup noise', () => {
    const src = 'intro\n## Commented\n{}\n## Other\nfoo';
    const first = parseContentIntoSections(src);
    const second = parseContentIntoSections(first.long_term);
    expect(second.dedup_state).toBe('');
    expect(second.long_term).toBe(first.long_term);
  });
});

describe('buildSectionsFromLegacyContent', () => {
  it('produces long_term and dedup_state sections with defaults', () => {
    const sections = buildSectionsFromLegacyContent('## Commented\n{}\n## Other\nx');
    expect(sections.long_term).toBeDefined();
    expect(sections.long_term.visibility).toBe('private');
    expect(typeof sections.long_term.byteSize).toBe('number');
    expect(sections.dedup_state).toBeDefined();
    expect(sections.dedup_state.visibility).toBe('private');
  });

  it('omits long_term when content is entirely dedup', () => {
    const sections = buildSectionsFromLegacyContent('## Commented\n{}');
    expect(sections.long_term).toBeUndefined();
    expect(sections.dedup_state).toBeDefined();
  });

  it('omits dedup_state when there is no dedup content', () => {
    const sections = buildSectionsFromLegacyContent('# Title\nbody');
    expect(sections.long_term).toBeDefined();
    expect(sections.dedup_state).toBeUndefined();
  });

  it('returns {} for empty/whitespace input', () => {
    expect(buildSectionsFromLegacyContent('')).toEqual({});
    expect(buildSectionsFromLegacyContent('   \n')).toEqual({});
  });

  it('counts byteSize in utf-8 bytes (multi-byte chars)', () => {
    const sections = buildSectionsFromLegacyContent('😀 hi');
    expect(sections.long_term?.byteSize).toBe(Buffer.byteLength('😀 hi', 'utf8'));
  });
});

describe('mirrorContentFromSections', () => {
  it('returns long_term.content when present', () => {
    expect(mirrorContentFromSections({ long_term: { content: 'hello' } })).toBe('hello');
  });

  it('returns empty string when sections are missing or have no long_term', () => {
    expect(mirrorContentFromSections(undefined)).toBe('');
    expect(mirrorContentFromSections({})).toBe('');
    expect(mirrorContentFromSections({ dedup_state: { content: 'x' } })).toBe('');
  });
});

describe('stampSectionsForWrite', () => {
  const FIXED = new Date('2026-04-14T12:00:00Z');

  it('stamps updatedAt and byteSize on single-object sections', () => {
    const out = stampSectionsForWrite({
      long_term: { content: 'hello' },
    }, FIXED);
    expect(out.long_term.content).toBe('hello');
    expect(out.long_term.updatedAt).toEqual(FIXED);
    expect(out.long_term.byteSize).toBe(5);
    expect(out.long_term.visibility).toBe('private');
  });

  it('computes byteSize in utf-8 bytes for multi-byte content', () => {
    const out = stampSectionsForWrite({ long_term: { content: '😀 hi' } }, FIXED);
    expect(out.long_term.byteSize).toBe(Buffer.byteLength('😀 hi', 'utf8'));
  });

  it('overrides client-supplied byteSize and updatedAt', () => {
    const out = stampSectionsForWrite({
      long_term: {
        content: 'x',
        byteSize: 9999,
        updatedAt: new Date('2000-01-01'),
      },
    }, FIXED);
    expect(out.long_term.byteSize).toBe(1);
    expect(out.long_term.updatedAt).toEqual(FIXED);
  });

  it('preserves caller-supplied visibility', () => {
    const out = stampSectionsForWrite({
      shared: { content: 'bio', visibility: 'public' },
    }, FIXED);
    expect(out.shared.visibility).toBe('public');
  });

  it('defaults visibility to private when omitted', () => {
    const out = stampSectionsForWrite({
      long_term: { content: 'x' },
    }, FIXED);
    expect(out.long_term.visibility).toBe('private');
  });

  it('only stamps sections present in input (no sibling creation)', () => {
    const out = stampSectionsForWrite({ dedup_state: { content: 'x' } }, FIXED);
    expect(out.dedup_state).toBeDefined();
    expect(out.long_term).toBeUndefined();
    expect(out.shared).toBeUndefined();
    expect(out.soul).toBeUndefined();
  });

  it('stamps daily entries without byteSize/updatedAt (per ADR shape)', () => {
    const out = stampSectionsForWrite({
      daily: [{ date: '2026-04-14', content: 'today', visibility: 'pod' }],
    }, FIXED);
    expect(out.daily).toHaveLength(1);
    expect(out.daily[0].date).toBe('2026-04-14');
    expect(out.daily[0].content).toBe('today');
    expect(out.daily[0].visibility).toBe('pod');
    expect(out.daily[0].byteSize).toBeUndefined();
    expect(out.daily[0].updatedAt).toBeUndefined();
  });

  it('stamps relationships entries with updatedAt but no byteSize', () => {
    const out = stampSectionsForWrite({
      relationships: [
        { otherInstanceId: 'nova', notes: 'met in dev', updatedAt: new Date('2000-01-01') },
      ],
    }, FIXED);
    expect(out.relationships).toHaveLength(1);
    expect(out.relationships[0].otherInstanceId).toBe('nova');
    expect(out.relationships[0].updatedAt).toEqual(FIXED);
    expect(out.relationships[0].byteSize).toBeUndefined();
  });

  it('is idempotent under same `now` — repeated stamping yields equivalent output (covers object + array sections)', () => {
    const input = {
      long_term: { content: 'x' },
      dedup_state: { content: '## Commented\n{}' },
      daily: [{ date: '2026-04-14', content: 'today', visibility: 'private' }],
      relationships: [{ otherInstanceId: 'nova', notes: 'n' }],
    };
    const a = stampSectionsForWrite(input, FIXED);
    const b = stampSectionsForWrite(a, FIXED);
    expect(b).toEqual(a);
  });
});

describe('isValidYMD', () => {
  it('accepts valid YYYY-MM-DD', () => {
    expect(isValidYMD('2026-04-14')).toBe(true);
    expect(isValidYMD('2000-01-01')).toBe(true);
    expect(isValidYMD('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed strings', () => {
    expect(isValidYMD('2026-4-14')).toBe(false);    // not zero-padded
    expect(isValidYMD('2026/04/14')).toBe(false);
    expect(isValidYMD('14-04-2026')).toBe(false);
    expect(isValidYMD('')).toBe(false);
    expect(isValidYMD('Apr 14')).toBe(false);
  });

  it('rejects calendar-invalid dates', () => {
    expect(isValidYMD('2026-02-30')).toBe(false);  // no Feb 30
    expect(isValidYMD('2026-13-01')).toBe(false);  // month 13
    expect(isValidYMD('2026-00-01')).toBe(false);  // month 0
    expect(isValidYMD('2026-04-00')).toBe(false);  // day 0
    expect(isValidYMD('2023-02-29')).toBe(false);  // non-leap year
  });

  it('rejects non-strings', () => {
    expect(isValidYMD(20260414)).toBe(false);
    expect(isValidYMD(undefined)).toBe(false);
    expect(isValidYMD(null)).toBe(false);
    expect(isValidYMD(new Date())).toBe(false);
  });
});

describe('mergePatchSections', () => {
  it('merges single-object sections per-key, preserving siblings', () => {
    const existing = {
      long_term: { content: 'keep', visibility: 'private', updatedAt: new Date(), byteSize: 4 },
      shared: { content: 'bio', visibility: 'public', updatedAt: new Date(), byteSize: 3 },
    };
    const incoming = {
      dedup_state: { content: '## C\n{}', visibility: 'private', updatedAt: new Date(), byteSize: 8 },
    };
    const out = mergePatchSections(existing, incoming);
    expect(out.long_term?.content).toBe('keep');
    expect(out.shared?.content).toBe('bio');
    expect(out.dedup_state?.content).toBe('## C\n{}');
  });

  it('replaces a single-object section when incoming has the same key', () => {
    const existing = { long_term: { content: 'old', visibility: 'private', updatedAt: new Date(), byteSize: 3 } };
    const incoming = { long_term: { content: 'new', visibility: 'private', updatedAt: new Date(), byteSize: 3 } };
    const out = mergePatchSections(existing, incoming);
    expect(out.long_term?.content).toBe('new');
  });

  it('merges daily entries by date (replace same-date, keep other dates)', () => {
    const existing = {
      daily: [
        { date: '2026-04-12', content: 'mon', visibility: 'private' },
        { date: '2026-04-13', content: 'tue', visibility: 'private' },
      ],
    };
    const incoming = {
      daily: [
        { date: '2026-04-13', content: 'tue-updated', visibility: 'private' },
        { date: '2026-04-14', content: 'wed', visibility: 'private' },
      ],
    };
    const out = mergePatchSections(existing, incoming);
    const byDate = Object.fromEntries((out.daily || []).map((d) => [d.date, d.content]));
    expect(byDate['2026-04-12']).toBe('mon');             // preserved
    expect(byDate['2026-04-13']).toBe('tue-updated');     // replaced
    expect(byDate['2026-04-14']).toBe('wed');             // added
    expect(out.daily?.length).toBe(3);
  });

  it('merges relationships by otherInstanceId', () => {
    const existing = {
      relationships: [
        { otherInstanceId: 'nova', notes: 'old nova', visibility: 'private', updatedAt: new Date() },
        { otherInstanceId: 'theo', notes: 'old theo', visibility: 'private', updatedAt: new Date() },
      ],
    };
    const incoming = {
      relationships: [
        { otherInstanceId: 'nova', notes: 'new nova', visibility: 'private', updatedAt: new Date() },
        { otherInstanceId: 'liz', notes: 'new liz', visibility: 'private', updatedAt: new Date() },
      ],
    };
    const out = mergePatchSections(existing, incoming);
    const byId = Object.fromEntries((out.relationships || []).map((r) => [r.otherInstanceId, r.notes]));
    expect(byId.nova).toBe('new nova');
    expect(byId.theo).toBe('old theo');
    expect(byId.liz).toBe('new liz');
    expect(out.relationships?.length).toBe(3);
  });

  it('handles missing existing doc (returns stamped incoming as-is)', () => {
    const incoming = { long_term: { content: 'x', visibility: 'private', updatedAt: new Date(), byteSize: 1 } };
    const out = mergePatchSections(undefined, incoming);
    expect(out.long_term?.content).toBe('x');
  });

  it('does not lose sections from existing that incoming omitted', () => {
    const existing = {
      soul: { content: 'who', visibility: 'private', updatedAt: new Date(), byteSize: 3 },
      long_term: { content: 'why', visibility: 'private', updatedAt: new Date(), byteSize: 3 },
    };
    const out = mergePatchSections(existing, {});
    expect(out.soul?.content).toBe('who');
    expect(out.long_term?.content).toBe('why');
  });
});

describe('computeSyncDedupKey', () => {
  const FIXED = new Date('2026-04-14T12:00:00Z');

  it('produces the same key for identical sections + runtime + mode on the same day', () => {
    const s = { long_term: { content: 'x' } };
    const a = computeSyncDedupKey(s, 'openclaw', 'patch', FIXED);
    const b = computeSyncDedupKey(s, 'openclaw', 'patch', FIXED);
    expect(a).toBe(b);
  });

  it('produces a different key when mode differs', () => {
    const s = { long_term: { content: 'x' } };
    expect(computeSyncDedupKey(s, 'openclaw', 'full', FIXED))
      .not.toBe(computeSyncDedupKey(s, 'openclaw', 'patch', FIXED));
  });

  it('produces a different key when sourceRuntime differs', () => {
    const s = { long_term: { content: 'x' } };
    expect(computeSyncDedupKey(s, 'openclaw', 'patch', FIXED))
      .not.toBe(computeSyncDedupKey(s, 'webhook', 'patch', FIXED));
  });

  it('produces a different key when the day rolls over', () => {
    const s = { long_term: { content: 'x' } };
    const day1 = new Date('2026-04-14T23:59:59Z');
    const day2 = new Date('2026-04-15T00:00:01Z');
    expect(computeSyncDedupKey(s, 'openclaw', 'patch', day1))
      .not.toBe(computeSyncDedupKey(s, 'openclaw', 'patch', day2));
  });

  it('produces a different key when section content differs by a byte', () => {
    expect(computeSyncDedupKey({ long_term: { content: 'x' } }, 'oc', 'patch', FIXED))
      .not.toBe(computeSyncDedupKey({ long_term: { content: 'y' } }, 'oc', 'patch', FIXED));
  });

  it('key starts with the UTC day', () => {
    const k = computeSyncDedupKey({ long_term: { content: 'x' } }, 'openclaw', 'patch', FIXED);
    expect(k).toMatch(/^2026-04-14:/);
  });

  it('is order-invariant on object keys (canonical stringify)', () => {
    const a = { long_term: { content: 'x', visibility: 'private' } };
    const b = { long_term: { visibility: 'private', content: 'x' } };
    expect(computeSyncDedupKey(a, 'openclaw', 'patch', FIXED))
      .toBe(computeSyncDedupKey(b, 'openclaw', 'patch', FIXED));
  });

  it('is order-invariant across multiple sections', () => {
    const a = { long_term: { content: 'x' }, shared: { content: 'y' } };
    const b = { shared: { content: 'y' }, long_term: { content: 'x' } };
    expect(computeSyncDedupKey(a, 'openclaw', 'patch', FIXED))
      .toBe(computeSyncDedupKey(b, 'openclaw', 'patch', FIXED));
  });
});
