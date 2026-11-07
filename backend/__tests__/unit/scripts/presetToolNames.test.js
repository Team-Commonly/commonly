/**
 * Guards scripts/verify-preset-tool-names.js, the part of the moltbot tool
 * contract that outlived the openclaw submodule (ADR-021 Part B).
 */

const fs = require('fs');

const {
  parsePresets,
  checkPresetToolNames,
  loadNativeTools,
  NAMED_AS_REMOVED,
  PRESETS_FILE,
  RETIRED_RUNTIMES,
} = require('../../../../scripts/verify-preset-tool-names');

describe('preset tool names resolve on the runtime the preset declares', () => {
  const presetBlock = (id, runtime, body = '') => [
    `    id: '${id}',`,
    `    runtime: '${runtime}',`,
    body,
  ].filter(Boolean).join('\n');

  // A source with enough blocks to clear the shape control, so a test about
  // anything else is not silently measuring the control instead.
  const manyPresets = (extra = []) => [
    ...Array.from({ length: 22 }, (_, i) => presetBlock(`filler-${i}`, 'openclaw')),
    ...extra,
  ].join('\n');

  describe('parsePresets', () => {
    it('extracts the id, the declared runtime and every tool name per block', () => {
      const presets = parsePresets(manyPresets([
        presetBlock(
          'social-amplifier', 
          'internal',
          '    prompt: `Only post final content via commonly_post_message.`,',
        ),
      ]));
      const amplifier = presets.find((p) => p.id === 'social-amplifier');
      expect(amplifier.runtime).toBe('internal');
      expect(amplifier.names).toEqual(['commonly_post_message']);
    });

    it('sees a tool named in prose, with no call parentheses', () => {
      // This is why the check is not call-position scoped: both `internal`
      // presets on main name their only tool in a sentence, so a
      // call-position check covers zero of the runtime this row is about.
      const [preset] = parsePresets(manyPresets([
        presetBlock(
          'prose-only', 
          'internal',
          '    prompt: `Run tools silently. Post via commonly_post_message only.`,',
        ),
      ])).filter((p) => p.id === 'prose-only');
      expect(preset.names).toContain('commonly_post_message');
    });

    it('refuses to report a result when the block shape no longer matches', () => {
      // Two blocks parse cleanly and mean nothing — the file has 30+. Without
      // this control a broken segmenter reports "0 presets, all names
      // resolved" and exits 0.
      expect(() => parsePresets(presetBlock('only-one', 'openclaw')))
        .toThrow(/parsed 1 preset definitions/);
    });

    it('refuses a block that declares no runtime rather than guessing one', () => {
      expect(() => parsePresets(manyPresets(["    id: 'runtime-less',"])))
        .toThrow(/'runtime-less' declares 0 distinct runtimes/);
    });

    it('refuses a block that declares several runtimes', () => {
      expect(() => parsePresets(manyPresets([[
        "    id: 'two-runtimes',",
        "    runtime: 'openclaw',",
        "    config: { runtime: 'internal' },",
      ].join('\n')]))).toThrow(/declares 2 distinct runtimes/);
    });

    it('parses the live presets.ts without tripping either refusal', () => {
      // Non-vacuity: every negative case above is satisfied by a parser that
      // throws on everything.
      const presets = parsePresets(fs.readFileSync(PRESETS_FILE, 'utf8'));
      expect(presets.length).toBeGreaterThanOrEqual(20);
      expect(presets.every((p) => p.runtime && p.id)).toBe(true);
    });
  });

  describe('loadNativeTools', () => {
    const nativeSource = (names) => `
const TOOLS = [
${names.map((n) => `  { type: 'function', function: { name: '${n}', description: '…' } },`).join('\n')}
];

const toolsForConfig = () => TOOLS;
`;

    it('slices the TOOLS array out of the live service', () => {
      const names = loadNativeTools();
      // Named, not counted: the point of resolving per-runtime is that this
      // surface spells shared capabilities differently from the extension's.
      expect(names.has('commonly_post_message')).toBe(true);
      expect(names.has('commonly_read_memory')).toBe(true);
      expect(names.has('commonly_read_agent_memory')).toBe(false);
    });

    it('refuses to report a result when the parse comes up short', () => {
      // A short parse marks every internal preset's tools missing — loud, and
      // wrong. Distinguish "the array shrank" from "the slice stopped matching".
      expect(() => loadNativeTools({ read: () => nativeSource(['commonly_post_message']) }))
        .toThrow(/parsed 1 tool names/);
    });

    it('refuses when the declaration is gone entirely', () => {
      expect(() => loadNativeTools({ read: () => 'export const TOOL_LIST = [];' }))
        .toThrow(/const TOOLS not found/);
    });

    it('does not count a name that only appears in a comment', () => {
      const withComment = `${nativeSource([
        'commonly_post_message', 'commonly_create_task', 'commonly_read_memory',
        'commonly_write_memory', 'commonly_read_context',
      ])}\n// TODO: add { name: 'commonly_ghost' } here\n`;
      const names = loadNativeTools({ read: () => withComment });
      expect(names.has('commonly_ghost')).toBe(false);
    });
  });

  describe('checkPresetToolNames', () => {
    const sets = {
      openclaw: new Set(['commonly_post_message', 'commonly_create_post']),
      internal: new Set(['commonly_post_message']),
    };
    const mentionsRemoved = NAMED_AS_REMOVED.map(
      (t, i) => presetBlock(`removed-note-${i}`, 'openclaw', `    prompt: \`${t} was removed.\`,`),
    );

    it('flags a name absent on the runtime its preset declares', () => {
      // The row's scenario: create_post exists on openclaw only, and is
      // correct today purely because all its sites sit in openclaw presets.
      const presets = parsePresets(manyPresets([
        ...mentionsRemoved,
        presetBlock('x-curator', 'internal', '    prompt: `Call commonly_create_post(podId).`,'),
      ]));
      const { missing } = checkPresetToolNames({ presets, sets });
      expect(missing).toHaveLength(1);
      expect(missing[0].tool).toBe('commonly_create_post');
      expect(missing[0].preset.id).toBe('x-curator');
      expect(missing[0].preset.runtime).toBe('internal');
      expect(missing[0].preset.line).toBeGreaterThan(0);
    });

    it('passes the same name when its preset declares a runtime that has it', () => {
      const presets = parsePresets(manyPresets([
        ...mentionsRemoved,
        presetBlock('x-curator', 'openclaw', '    prompt: `Call commonly_create_post(podId).`,'),
      ]));
      expect(checkPresetToolNames({ presets, sets }).missing).toHaveLength(0);
    });

    it('reports a runtime it has no tool set for instead of skipping it', () => {
      // Silence here is the failure this whole file exists to prevent: an
      // unchecked runtime renders identically to a checked one that passed.
      const presets = parsePresets(manyPresets([
        ...mentionsRemoved,
        presetBlock('cc-preset', 'claude-code', '    prompt: `Call commonly_post_message.`,'),
      ]));
      const { missing, uncovered } = checkPresetToolNames({ presets, sets });
      expect(missing).toHaveLength(0);
      expect(uncovered).toHaveLength(1);
      expect(uncovered[0].preset.runtime).toBe('claude-code');
      expect(uncovered[0].names).toContain('commonly_post_message');
    });

    it('exempts the names presets.ts mentions only to say they were removed', () => {
      const presets = parsePresets(manyPresets(mentionsRemoved));
      expect(checkPresetToolNames({ presets, sets }).missing).toHaveLength(0);
    });

    it('refuses an exemption that outlives the sentence justifying it', () => {
      // Same self-check as namedForOtherDrivers: an exclusion nobody revisits
      // silently widens into a licence for a future real use of the name.
      const presets = parsePresets(manyPresets());
      expect(() => checkPresetToolNames({ presets, sets }))
        .toThrow(/no longer mentions it/);
    });

    it('skips a retired runtime without calling it uncovered', () => {
      const presets = parsePresets(manyPresets([
        ...mentionsRemoved,
        presetBlock('old-seat', 'gone', '    prompt: `Call commonly_create_post(podId).`,'),
      ]));
      const { missing, uncovered, retiredCount } = checkPresetToolNames({ presets, sets, retired: ['gone'] });
      expect(missing).toHaveLength(0);
      expect(uncovered).toHaveLength(0);
      expect(retiredCount).toBe(1);
    });

    it('passes the live presets against the live native runtime', () => {
      const result = checkPresetToolNames({
        presets: parsePresets(fs.readFileSync(PRESETS_FILE, 'utf8')),
        sets: { internal: loadNativeTools() },
        retired: RETIRED_RUNTIMES,
      });
      expect(result.missing).toEqual([]);
      expect(result.uncovered).toEqual([]);
    });
  });
});
