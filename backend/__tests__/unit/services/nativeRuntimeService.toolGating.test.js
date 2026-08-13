/**
 * ADR-020 D1 — the manifest tool allowlist is ENFORCED, not decorative.
 *
 * Before toolsForConfig, TOOLS went unfiltered to every native agent and
 * each definition's `tools` list was documentation. Now: a declared list
 * filters exactly; an undeclared (legacy) config keeps the pre-gate surface
 * MINUS approval proposing, which is opt-in by declaration only.
 */
const { toolsForConfig } = require('../../../services/nativeRuntimeService');

const names = (tools) => tools.map((t) => t.function.name);

describe('toolsForConfig', () => {
  test('a declared allowlist filters exactly', () => {
    const tools = toolsForConfig({ tools: ['commonly_post_message', 'commonly_propose_action'] });
    expect(names(tools).sort()).toEqual(['commonly_post_message', 'commonly_propose_action']);
  });

  test('legacy configs without a tool list never see propose_action', () => {
    for (const cfg of [null, undefined, {}, { tools: 'not-an-array' }]) {
      const tools = toolsForConfig(cfg);
      expect(names(tools)).not.toContain('commonly_propose_action');
      // ...but keep the pre-gate surface working (back-compat).
      expect(names(tools)).toContain('commonly_post_message');
      expect(names(tools)).toContain('commonly_read_context');
    }
  });

  test('the guide manifest grants propose_action', () => {
    // eslint-disable-next-line global-require
    const { guideApp } = require('../../../config/native-agents/guide');
    const tools = toolsForConfig({ tools: [...guideApp.tools] });
    expect(names(tools)).toContain('commonly_propose_action');
    // The manifest and the runtime's schema must agree — a declared tool with
    // no schema would silently vanish here.
    expect(tools.length).toBe(guideApp.tools.length);
  });
});
