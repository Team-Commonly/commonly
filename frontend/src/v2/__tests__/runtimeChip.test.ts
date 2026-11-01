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

  it('shows webhook only for a real push webhook agent with no adapter', () => {
    // Install stamps host: 'byo' on every webhook-typed seat without a URL,
    // so a push webhook carries no host (registry/install.ts).
    expect(runtimeChipLabel({ runtimeType: 'webhook' })).toBe('webhook');
  });

  it('TASK-317: a BYO seat names the CLI it reported, after any declared adapter', () => {
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: 'byo', reportedCli: 'claude' })).toBe('claude');
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: 'byo', reportedCli: 'pi' })).toBe('pi');
    // TASK-704: a stale codex declaration on a seat that polls claude shows the poller.
    expect(runtimeChipLabel({ runtimeType: 'codex', host: 'byo', reportedCli: 'claude' })).toBe('claude');
    expect(runtimeChipLabel({ runtimeType: 'codex', host: 'byo' })).toBe('codex');
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: 'byo', adapter: 'codex', reportedCli: 'claude' })).toBe('codex');
    expect(runtimeChipLabel({ runtimeType: 'local-cli', wrappedCli: 'codex', reportedCli: 'claude' })).toBe('codex');
    expect(runtimeChipLabel({ runtimeType: 'hosted', reportedCli: 'claude' })).toBe('hosted');
  });

  it('TASK-317: a BYO seat on an older CLI that reports nothing reads CLI, never webhook', () => {
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: 'byo' })).toBe('CLI');
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: ' BYO ' })).toBe('CLI');
    expect(runtimeChipLabel({ runtimeType: 'webhook', host: 'cloud' })).toBe('webhook');
  });

  it('maps hosted and internal runtimes to hosted', () => {
    expect(runtimeChipLabel({ runtimeType: 'hosted' })).toBe('hosted');
    expect(runtimeChipLabel({ runtimeType: 'internal' })).toBe('hosted');
  });

  it('keeps a hosted seat hosted even if a config write set an adapter on it', () => {
    expect(runtimeChipLabel({ runtimeType: 'hosted', adapter: 'codex' })).toBe('hosted');
    expect(runtimeChipLabel({ runtimeType: 'internal', adapter: 'claude' })).toBe('hosted');
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
