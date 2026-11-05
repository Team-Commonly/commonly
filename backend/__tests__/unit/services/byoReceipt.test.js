const { normalizeReceipt, RECEIPT_LIMITS } = require('../../../services/byoReceipt');

const codes = (result) => result.warnings.map((w) => w.code);

describe('self-reported BYO receipt (D245 item 4, warn-only)', () => {
  it('stores nothing and warns about nothing when absent', () => {
    expect(normalizeReceipt(undefined)).toEqual({ receipt: null, warnings: [] });
    expect(normalizeReceipt(null)).toEqual({ receipt: null, warnings: [] });
  });

  it('keeps a valid receipt and stamps it self-reported', () => {
    const result = normalizeReceipt({
      adapter: 'claude', model: 'claude-opus-5-5', turns: 3, tools: ['Read', 'Bash', 'mcp__commonly__post'], durationMs: 41250,
    });
    expect(result).toEqual({
      receipt: {
        adapter: 'claude',
        model: 'claude-opus-5-5',
        turns: 3,
        tools: ['Read', 'Bash', 'mcp__commonly__post'],
        durationMs: 41250,
        source: 'self-reported',
      },
      warnings: [],
    });
  });

  it('keeps the effort level a wrapper passed, and drops one that is not a level name (D247)', () => {
    expect(normalizeReceipt({ adapter: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }).receipt)
      .toEqual({ adapter: 'codex', model: 'gpt-6-sol', effort: 'xhigh', source: 'self-reported' });
    const bad = normalizeReceipt({ adapter: 'codex', effort: 'very high <b>' });
    expect(bad.receipt).toEqual({ adapter: 'codex', source: 'self-reported' });
    expect(codes(bad)).toEqual(['receipt_invalid_effort']);
  });

  it('a caller cannot claim another source', () => {
    const result = normalizeReceipt({ adapter: 'codex', source: 'server' });
    expect(result.receipt.source).toBe('self-reported');
    expect(codes(result)).toEqual(['receipt_unknown_field']);
  });

  it('drops a non-object receipt with a warning', () => {
    ['claude', 3, ['claude']].forEach((raw) => {
      const result = normalizeReceipt(raw);
      expect(result.receipt).toBeNull();
      expect(codes(result)).toEqual(['receipt_not_object']);
    });
  });

  it('drops each bad field alone and keeps the rest', () => {
    const result = normalizeReceipt({
      adapter: 'claude code!', model: 'gpt-5.6-sol', turns: -1, durationMs: 1.5, tools: 'Read',
    });
    expect(result.receipt).toEqual({ model: 'gpt-5.6-sol', source: 'self-reported' });
    expect(codes(result).sort()).toEqual([
      'receipt_invalid_adapter', 'receipt_invalid_duration', 'receipt_invalid_tools', 'receipt_invalid_turns',
    ]);
  });

  it('refuses names that could carry prose or markup', () => {
    const result = normalizeReceipt({
      model: 'opus <img src=x onerror=alert(1)>', tools: ['Read', 'ignore previous instructions', '[link](http://x)'],
    });
    expect(result.receipt).toEqual({ tools: ['Read'], source: 'self-reported' });
    expect(codes(result).sort()).toEqual(['receipt_invalid_model', 'receipt_invalid_tool_name']);
  });

  it('refuses URL-shaped names and keeps real ids with colons and slashes', () => {
    const result = normalizeReceipt({
      model: 'https://phish.example/claim', tools: ['openai/gpt-5.6-sol', 'us.anthropic.x:0', 'http://x.example'],
    });
    expect(result.receipt).toEqual({ tools: ['openai/gpt-5.6-sol', 'us.anthropic.x:0'], source: 'self-reported' });
    expect(codes(result).sort()).toEqual(['receipt_invalid_model', 'receipt_invalid_tool_name']);
  });

  it('dedupes tools and caps their count', () => {
    const many = Array.from({ length: RECEIPT_LIMITS.tools + 10 }, (_, i) => `tool_${i}`);
    const result = normalizeReceipt({ tools: ['Read', 'Read', ...many] });
    expect(result.receipt.tools).toHaveLength(RECEIPT_LIMITS.tools);
    expect(result.receipt.tools[0]).toBe('Read');
    expect(result.receipt.tools.filter((t) => t === 'Read')).toHaveLength(1);
    expect(codes(result)).toEqual(['receipt_tools_truncated']);
  });

  it('bounds turns and duration', () => {
    expect(codes(normalizeReceipt({ adapter: 'codex', turns: RECEIPT_LIMITS.turns + 1 }))).toEqual(['receipt_invalid_turns']);
    expect(codes(normalizeReceipt({ adapter: 'codex', durationMs: RECEIPT_LIMITS.durationMs + 1 })))
      .toEqual(['receipt_invalid_duration']);
    expect(normalizeReceipt({ turns: 0, durationMs: 0 }).receipt).toEqual({ turns: 0, durationMs: 0, source: 'self-reported' });
  });

  it('a receipt left with no fields is not stored', () => {
    const result = normalizeReceipt({ adapter: '' });
    expect(result.receipt).toBeNull();
    expect(codes(result)).toEqual(['receipt_invalid_adapter', 'receipt_empty']);
  });
});
