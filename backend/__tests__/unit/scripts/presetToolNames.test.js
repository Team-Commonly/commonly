/**
 * Guards scripts/verify-preset-tool-names.js, the part of the moltbot tool
 * contract that outlived the openclaw submodule (ADR-021 Part B).
 */

const fs = require('fs');

const {
  parsePresets,
  checkPresetToolNames,
  loadNativeTools,
  stripComments,
  PRESETS_FILE,
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
    ...Array.from({ length: 4 }, (_, i) => presetBlock(`filler-${i}`, 'webhook')),
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
      // One block parses cleanly and means nothing — the file has 4+. Without
      // this control a broken segmenter reports "0 presets, all names
      // resolved" and exits 0.
      expect(() => parsePresets(presetBlock('only-one', 'openclaw')))
        .toThrow(/parsed 1 preset definitions/);
    });

    it('refuses a block that declares no runtime rather than guessing one', () => {
      expect(() => parsePresets(manyPresets(["    id: 'runtime-less',"])))
        .toThrow(/'runtime-less' declares 0 distinct runtimes/);
    });

    it('reads a block whatever quotes its id and runtime use', () => {
      const presets = parsePresets(manyPresets(['    id: "double",\n    runtime: "internal",\n    prompt: `commonly_ghost`,']));
      expect(presets.find((p) => p.id === 'double')).toMatchObject({ runtime: 'internal', names: ['commonly_ghost'] });
    });

    it('refuses a boundary with no readable id instead of merging it into the block above', () => {
      expect(() => parsePresets(manyPresets(['    id: PRESET_ID,\n    runtime: \'internal\',']))).toThrow(/no readable id/);
    });

    it('sees a tool named after a // inside a prompt', () => {
      const [preset] = parsePresets(manyPresets([presetBlock(
        'slashes', 'internal', '    prompt: `Use a path like a//b then commonly_ghost.`,',
      )])).filter((p) => p.id === 'slashes');
      expect(preset.names).toContain('commonly_ghost');
    });

    it('still blanks real comments, and a quote inside one changes nothing', () => {
      expect(stripComments("const a = 1; // don't name commonly_ghost\nconst b = 'x';")).not.toContain('commonly_ghost');
      expect(stripComments("/* commonly_ghost */\nconst u = 'https://x.test';")).toContain('https://x.test');
    });

    it('refuses a block that declares several runtimes', () => {
      expect(() => parsePresets(manyPresets([[
        "    id: 'two-runtimes',",
        "    runtime: 'openclaw',",
        "    config: { runtime: 'internal' },",
      ].join('\n')]))).toThrow(/declares 2 distinct runtimes/);
    });

    it('ends the last block where the preset array closes, not at the end of the file', () => {
      const presets = parsePresets(`${manyPresets([presetBlock('last', 'webhook')])}\n];\nconst TRAILER = \`commonly_log_cycle\`;`);
      expect(presets.find((p) => p.id === 'last').names).toEqual([]);
    });

    it('parses the live presets.ts without tripping either refusal', () => {
      // Non-vacuity: every negative case above is satisfied by a parser that
      // throws on everything.
      const presets = parsePresets(fs.readFileSync(PRESETS_FILE, 'utf8'));
      expect(presets.length).toBeGreaterThanOrEqual(4);
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
      // Inside the array, or the slice would drop it whether or not comments are stripped.
      const withComment = nativeSource([
        'commonly_post_message', 'commonly_create_task', 'commonly_read_memory',
        'commonly_write_memory', 'commonly_read_context',
      ]).replace('];', "  // { type: 'function', function: { name: 'commonly_ghost' } },\n];");
      expect(withComment).toMatch(/commonly_ghost[\s\S]*\];/);
      const names = loadNativeTools({ read: () => withComment });
      expect(names.has('commonly_ghost')).toBe(false);
      expect(names.has('commonly_read_context')).toBe(true);
    });
  });

  describe('checkPresetToolNames', () => {
    const sets = {
      openclaw: new Set(['commonly_post_message', 'commonly_create_post']),
      internal: new Set(['commonly_post_message']),
    };

    it('flags a name absent on the runtime its preset declares', () => {
      // create_post exists on the openclaw set only, so an internal preset
      // that teaches it names a tool its driver does not have.
      const presets = parsePresets(manyPresets([
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
        presetBlock('x-curator', 'openclaw', '    prompt: `Call commonly_create_post(podId).`,'),
      ]));
      expect(checkPresetToolNames({ presets, sets }).missing).toHaveLength(0);
    });

    it('reports a runtime it has no tool set for instead of skipping it', () => {
      // Silence here is the failure this whole file exists to prevent: an
      // unchecked runtime renders identically to a checked one that passed.
      const presets = parsePresets(manyPresets([
        presetBlock('cc-preset', 'claude-code', '    prompt: `Call commonly_post_message.`,'),
      ]));
      const { missing, uncovered } = checkPresetToolNames({ presets, sets });
      expect(missing).toHaveLength(0);
      expect(uncovered).toHaveLength(1);
      expect(uncovered[0].preset.runtime).toBe('claude-code');
      expect(uncovered[0].names).toContain('commonly_post_message');
    });

    it('fails an instruction to call a tool the runtime does not have', () => {
      const presets = parsePresets(manyPresets([
        presetBlock('calls-it', 'internal', '    prompt: `Read the change with commonly_pr_diff.`,'),
      ]));
      const { missing } = checkPresetToolNames({ presets, sets });
      expect(missing.map((m) => m.tool)).toEqual(['commonly_pr_diff']);
    });

    it('passes the live presets against the live native runtime', () => {
      const result = checkPresetToolNames({
        presets: parsePresets(fs.readFileSync(PRESETS_FILE, 'utf8')),
        sets: { internal: loadNativeTools() },
      });
      expect(result.missing).toEqual([]);
      expect(result.uncovered).toEqual([]);
    });
  });
});
