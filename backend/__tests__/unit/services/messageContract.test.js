const { normalizeMessageContract, MESSAGE_KINDS, SUMMARY_MAX_CHARS } = require('../../../services/messageContract');
const AgentMessageService = require('../../../services/agentMessageService');

const sanitize = (text) => AgentMessageService.sanitizeAgentContent(text);
const normalize = (input) => normalizeMessageContract(input, sanitize);
const codes = (result) => result.warnings.map((w) => w.code);

describe('message contract (D245, warn-only)', () => {
  it('stores nothing and warns about nothing when both fields are absent', () => {
    expect(normalize({})).toEqual({ summary: null, kind: null, warnings: [] });
    expect(normalize({ summary: null, kind: null })).toEqual({ summary: null, kind: null, warnings: [] });
  });

  it('keeps a valid summary and kind', () => {
    expect(normalize({ summary: '  Fixed the login redirect  ', kind: 'result' }))
      .toEqual({ summary: 'Fixed the login redirect', kind: 'result', warnings: [] });
  });

  it('accepts every listed kind, case-insensitively', () => {
    MESSAGE_KINDS.forEach((kind) => expect(normalize({ kind: kind.toUpperCase() }).kind).toBe(kind));
  });

  it('drops an unknown kind with a warning instead of refusing', () => {
    const result = normalize({ summary: 'ok', kind: 'reasoning' });
    expect(result.kind).toBeNull();
    expect(result.summary).toBe('ok');
    expect(codes(result)).toEqual(['kind_unknown']);
  });

  it('drops a non-string kind or summary with a warning', () => {
    expect(codes(normalize({ kind: 3 }))).toEqual(['kind_unknown']);
    const result = normalize({ summary: { text: 'x' } });
    expect(result.summary).toBeNull();
    expect(codes(result)).toEqual(['summary_not_string']);
  });

  it('turns line breaks into spaces with a warning', () => {
    const result = normalize({ summary: 'first line\r\n\nsecond line' });
    expect(result.summary).toBe('first line second line');
    expect(codes(result)).toEqual(['summary_newline']);
  });

  it('cuts at 120 code points with a warning', () => {
    const result = normalize({ summary: 'a'.repeat(130) });
    expect(Array.from(result.summary)).toHaveLength(SUMMARY_MAX_CHARS);
    expect(codes(result)).toEqual(['summary_truncated']);
    expect(codes(normalize({ summary: 'a'.repeat(120) }))).toEqual([]);
  });

  it('never splits an emoji at the boundary', () => {
    // 119 ASCII chars, then an emoji that is two UTF-16 units: a .slice(0, 120)
    // would keep half of it.
    const summary = `${'a'.repeat(119)}🙂🙂`;
    const result = normalize({ summary });
    expect(result.summary).toBe(`${'a'.repeat(119)}🙂`);
    expect(result.summary).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('cuts a Chinese summary by characters, not bytes or units', () => {
    const zh = '修复了登录后的跳转问题'.repeat(12); // 132 characters
    const result = normalize({ summary: zh });
    expect(Array.from(result.summary)).toHaveLength(SUMMARY_MAX_CHARS);
    expect(zh.startsWith(result.summary)).toBe(true);
    expect(codes(result)).toEqual(['summary_truncated']);
  });

  it('runs the summary through the same sanitizer as the content', () => {
    // An opening sentinel silences content; it silences a summary the same way.
    const silenced = normalize({ summary: 'NO_REPLY' });
    expect(silenced.summary).toBeNull();
    expect(codes(silenced)).toEqual(['summary_empty']);
    expect(normalize({ summary: 'Done NO_REPLY' }).summary)
      .toBe(sanitize('Done NO_REPLY'));
    const seen = [];
    normalizeMessageContract({ summary: 'checked it' }, (text) => { seen.push(text); return text; });
    expect(seen).toEqual(['checked it']);
  });

  it('a whitespace-only summary is simply absent', () => {
    expect(normalize({ summary: '   ' })).toEqual({ summary: null, kind: null, warnings: [] });
  });
});
