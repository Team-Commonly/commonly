import { runtimeChipLabel } from '../utils/runtimeChip';

describe('runtimeChipLabel (TASK-471)', () => {
  it('names the wrapped CLI, not the webhook runtimeType it was installed with', () => {
    expect(runtimeChipLabel({ runtimeType: 'webhook', adapter: 'claude' })).toBe('claude');
    expect(runtimeChipLabel({ runtimeType: 'webhook', adapter: 'codex' })).toBe('codex');
  });

  it('maps opencode and dsh adapters to their own chips', () => {
    expect(runtimeChipLabel({ runtimeType: 'webhook', adapter: 'opencode' })).toBe('opencode');
    expect(runtimeChipLabel({ runtimeType: 'webhook', adapter: 'dsh' })).toBe('dsh');
  });

  it('reads the legacy wrappedCli shape when no adapter is declared', () => {
    expect(runtimeChipLabel({ wrappedCli: 'codex' })).toBe('codex');
  });

  it('shows webhook only for a real webhook agent with no adapter', () => {
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: 'byo' })).toBe('webhook');
  });

  it('maps hosted and internal runtimes to hosted', () => {
    expect(runtimeChipLabel({ runtimeType: 'hosted' })).toBe('hosted');
    expect(runtimeChipLabel({ runtimeType: 'internal' })).toBe('hosted');
  });

  it('keeps the claude-code and openclaw runtime types', () => {
    expect(runtimeChipLabel({ runtimeType: 'claude-code' })).toBe('claude');
    expect(runtimeChipLabel({ runtimeType: 'moltbot' })).toBe('openclaw');
  });

  it('returns null when no runtime is known or the type is unrecognised', () => {
    expect(runtimeChipLabel(null)).toBeNull();
    expect(runtimeChipLabel({})).toBeNull();
    expect(runtimeChipLabel({ runtimeType: 'something-new' })).toBeNull();
  });

  it('shows an adapter it does not map by its own name rather than dropping the chip', () => {
    expect(runtimeChipLabel({ runtimeType: 'webhook', adapter: 'pi' })).toBe('pi');
  });
});
