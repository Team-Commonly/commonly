// @ts-nocheck
// ADR-003 Phase 1: parser logic that maps legacy v1 `content` blobs into
// v2 `sections`. Pure functions — no DB required.

const {
  parseContentIntoSections,
  buildSectionsFromLegacyContent,
  mirrorContentFromSections,
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
