const { HARNESS_CATALOG, harnessCatalogEntry } = require('../../../config/harnessCatalog');

describe('harness catalogue (D247)', () => {
  it('lists every harness `commonly agent run --adapter` accepts, Claude Code and Codex first', () => {
    expect(HARNESS_CATALOG.map((entry) => entry.id))
      .toEqual(['claude', 'codex', 'opencode', 'qwen', 'goose', 'hermes', 'pi', 'dsh']);
  });

  it('names models by their full id only, and only where the list was checked on a real run', () => {
    expect(harnessCatalogEntry('claude')?.models)
      .toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(harnessCatalogEntry('codex')?.models).toEqual(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra',
      'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    for (const id of ['opencode', 'qwen', 'goose', 'hermes', 'pi', 'dsh']) {
      expect(harnessCatalogEntry(id)?.models).toBeNull();
    }
    for (const entry of HARNESS_CATALOG) {
      for (const model of entry.models || []) expect(typeof model).toBe('string');
    }
  });

  it('gives each harness the effort ladder its adapter passes, and none where there is no flag', () => {
    const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(harnessCatalogEntry('claude')?.efforts).toEqual(ladder);
    expect(harnessCatalogEntry('codex')?.efforts).toEqual(ladder);
    expect(harnessCatalogEntry('dsh')?.efforts).toEqual(ladder);
    expect(harnessCatalogEntry('pi')?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const id of ['opencode', 'qwen', 'goose', 'hermes']) expect(harnessCatalogEntry(id)?.efforts).toEqual([]);
  });

  it('carries labels and no test-status marks', () => {
    expect(harnessCatalogEntry('claude')?.label).toBe('Claude Code');
    expect(harnessCatalogEntry('claude-code')?.id).toBe('claude');
    expect(harnessCatalogEntry('nope')).toBeNull();
    for (const entry of HARNESS_CATALOG) expect(Object.keys(entry).sort()).toEqual(['efforts', 'id', 'label', 'models']);
  });
});
