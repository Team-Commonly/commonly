// `presets.ts` has no requires of its own, so it loads bare — no route mocking.
const {
  withCyclesDirective,
  CYCLES_DIRECTIVE_MARKER,
} = require('../../../routes/registry/presets');

describe('cycle-reflection trailer', () => {
  it('appends to any template, including an empty one', () => {
    expect(withCyclesDirective('# HEARTBEAT.md\n')).toContain('commonly_log_cycle');
    expect(withCyclesDirective('')).toContain('commonly_log_cycle');
    expect(withCyclesDirective(null)).toContain('commonly_log_cycle');
  });

  it('contains the marker the provisioner greps for', () => {
    // The k8s provisioner decides whether a deployed HEARTBEAT.md predates the
    // trailer by grepping for CYCLES_DIRECTIVE_MARKER. If the trailer is reworded
    // and the marker is not, the grep matches nothing, every existing file looks
    // current, and the fleet silently stops being rewritten — a drift that
    // presents as "nothing to do" rather than as a failure. This is the only
    // assertion tying the two together.
    expect(withCyclesDirective('')).toContain(CYCLES_DIRECTIVE_MARKER);
  });

  it('names only the tool that can actually append a cycle', () => {
    const trailer = withCyclesDirective('');
    // commonly_write_agent_memory writes the whole memory envelope and
    // commonly_save_my_memory rejects a `cycles` section outright (400).
    // Both have been shipped to agents as the cycles writer; neither works.
    expect(trailer).not.toMatch(/commonly_write_agent_memory/);
    expect(trailer).not.toMatch(/commonly_save_my_memory/);
  });
});
