// @ts-nocheck
// ADR-003 Phase 4: visibility filter for cross-agent memory reads.
// Pure function — no DB required. Covers visibility precedence rules
// (private never leaks, public always returned, pod requires overlap)
// AND per-element filtering for daily[]/relationships[].

const {
  filterSectionsByVisibility,
} = require('../../../services/agentMemoryService');

const POD_A = '507f1f77bcf86cd799439011';
const POD_B = '507f1f77bcf86cd799439012';
const POD_C = '507f1f77bcf86cd799439013';

const sec = (content, visibility) => ({
  content,
  visibility,
  updatedAt: new Date('2026-04-15T00:00:00Z'),
  byteSize: Buffer.byteLength(content, 'utf8'),
});

describe('filterSectionsByVisibility', () => {
  it('returns {} for undefined sections', () => {
    expect(filterSectionsByVisibility(undefined, [POD_A], [POD_A])).toEqual({});
  });

  it('returns {} for empty sections', () => {
    expect(filterSectionsByVisibility({}, [POD_A], [POD_A])).toEqual({});
  });

  it('returns public sections regardless of pod overlap', () => {
    const sections = {
      shared: sec('public bio', 'public'),
      runtime_meta: sec('claude-code', 'public'),
    };
    const out = filterSectionsByVisibility(sections, [], []); // no overlap at all
    expect(out.shared.content).toBe('public bio');
    expect(out.runtime_meta.content).toBe('claude-code');
  });

  it('returns pod sections when requester and owner share at least one pod', () => {
    const sections = { shared: sec('pod bio', 'pod') };
    const out = filterSectionsByVisibility(sections, [POD_A, POD_B], [POD_B, POD_C]);
    expect(out.shared.content).toBe('pod bio');
  });

  it('strips pod sections when there is no pod overlap', () => {
    const sections = { shared: sec('pod bio', 'pod') };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_B, POD_C]);
    expect(out.shared).toBeUndefined();
  });

  it('NEVER returns private sections — even when requester and owner share every pod', () => {
    const sections = {
      long_term: sec('curated secrets', 'private'),
      soul: sec('who I am', 'private'),
    };
    const out = filterSectionsByVisibility(
      sections,
      [POD_A, POD_B, POD_C],
      [POD_A, POD_B, POD_C],
    );
    expect(out.long_term).toBeUndefined();
    expect(out.soul).toBeUndefined();
  });

  it('treats missing visibility as private (defensive default)', () => {
    const sections = {
      // Section with NO visibility set — older record / pre-Phase-4 state.
      long_term: { content: 'unknown viz', updatedAt: new Date(), byteSize: 11 },
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    expect(out.long_term).toBeUndefined();
  });

  it('treats unknown visibility values as private (defense in depth)', () => {
    const sections = {
      // A section that somehow ended up with an invalid visibility — corrupt
      // DB row, malicious write that bypassed validation, etc. The filter
      // must default to "deny," not "allow."
      shared: { content: 'invalid', visibility: 'everyone', updatedAt: new Date(), byteSize: 7 },
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    expect(out.shared).toBeUndefined();
  });

  it('mixes section visibilities correctly in one envelope', () => {
    const sections = {
      soul: sec('private soul', 'private'),
      long_term: sec('public long_term', 'public'),
      shared: sec('pod shared', 'pod'),
      dedup_state: sec('private dedup', 'private'),
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    expect(out.soul).toBeUndefined();
    expect(out.long_term.content).toBe('public long_term');
    expect(out.shared.content).toBe('pod shared');
    expect(out.dedup_state).toBeUndefined();
  });

  it('handles ghost installations (owner has no pods at all)', () => {
    // Edge case: owner's AgentInstallation rows are gone (uninstalled or
    // never existed), but the AgentMemory row survives (per ADR-003 invariant
    // 7). A 'pod' visibility section MUST NOT leak just because no pod context
    // can be established to deny it.
    const sections = { shared: sec('pod bio', 'pod') };
    const out = filterSectionsByVisibility(sections, [POD_A], []);
    expect(out.shared).toBeUndefined();
  });

  it('handles requester with no authorized pods', () => {
    // Requester somehow has no authorized pods (fresh agent, all installs
    // uninstalled). 'pod' sections must not leak.
    const sections = { shared: sec('pod bio', 'pod') };
    const out = filterSectionsByVisibility(sections, [], [POD_A]);
    expect(out.shared).toBeUndefined();
  });

  it('filters daily[] entries element-wise', () => {
    const sections = {
      daily: [
        { date: '2026-04-12', content: 'public day', visibility: 'public' },
        { date: '2026-04-13', content: 'private day', visibility: 'private' },
        { date: '2026-04-14', content: 'pod day', visibility: 'pod' },
        { date: '2026-04-15', content: 'no viz day' }, // missing visibility
      ],
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    const dates = out.daily.map((d) => d.date);
    expect(dates).toEqual(['2026-04-12', '2026-04-14']);
  });

  it('omits daily[] entirely when no entry survives filtering', () => {
    const sections = {
      daily: [
        { date: '2026-04-12', content: 'p', visibility: 'private' },
        { date: '2026-04-13', content: 'p', visibility: 'private' },
      ],
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    expect(out.daily).toBeUndefined();
  });

  it('filters relationships[] entries element-wise', () => {
    const sections = {
      relationships: [
        {
          otherInstanceId: 'nova',
          notes: 'public note',
          visibility: 'public',
          updatedAt: new Date(),
        },
        {
          otherInstanceId: 'theo',
          notes: 'private note',
          visibility: 'private',
          updatedAt: new Date(),
        },
        {
          otherInstanceId: 'liz',
          notes: 'pod note',
          visibility: 'pod',
          updatedAt: new Date(),
        },
      ],
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    const ids = out.relationships.map((r) => r.otherInstanceId);
    expect(ids).toEqual(['nova', 'liz']);
  });

  it('omits relationships[] entirely when no entry survives filtering', () => {
    const sections = {
      relationships: [
        {
          otherInstanceId: 'nova',
          notes: 'p',
          visibility: 'pod',
          updatedAt: new Date(),
        },
      ],
    };
    const out = filterSectionsByVisibility(sections, [POD_A], [POD_B]); // no overlap
    expect(out.relationships).toBeUndefined();
  });

  it('does not mutate the input sections object', () => {
    const sections = {
      long_term: sec('private secret', 'private'),
      shared: sec('public bio', 'public'),
      daily: [
        { date: '2026-04-12', content: 'pub', visibility: 'public' },
        { date: '2026-04-13', content: 'priv', visibility: 'private' },
      ],
    };
    const snapshot = JSON.stringify(sections);
    filterSectionsByVisibility(sections, [POD_A], [POD_A]);
    expect(JSON.stringify(sections)).toBe(snapshot);
  });

  it('coerces ObjectId-like strings via String() — works with mongoose ids', () => {
    // Real call sites pass ObjectId.toString() values; defend against
    // accidental object-shaped pod ids too (Set membership uses String()).
    const sections = { shared: sec('pod bio', 'pod') };
    // ObjectId-shaped object (mongoose returns these when not converted)
    const podObj = { toString: () => POD_A };
    const out = filterSectionsByVisibility(sections, [POD_A], [podObj]);
    expect(out.shared.content).toBe('pod bio');
  });

  it('ignores null/undefined entries in pod arrays defensively', () => {
    const sections = { shared: sec('pod bio', 'pod') };
    const out = filterSectionsByVisibility(
      sections,
      [null, POD_A, undefined],
      [undefined, POD_A, null],
    );
    expect(out.shared.content).toBe('pod bio');
  });
});
