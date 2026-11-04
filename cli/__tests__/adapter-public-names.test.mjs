import { listAdapterNames, listPublicAdapterNames } from '../src/lib/adapters/index.js';
import { Command } from 'commander';
import { registerAgent } from '../src/commands/agent.js';

// The adapters a person can choose are the registry minus the test stub, and
// the help text reads the same list, so a new adapter never goes unlisted.
describe('public adapter names', () => {
  test('every registered adapter but stub', () => {
    expect(listPublicAdapterNames()).toEqual(listAdapterNames().filter((n) => n !== 'stub'));
    expect(listPublicAdapterNames()).toEqual(
      expect.arrayContaining(['claude', 'codex', 'pi', 'opencode', 'qwen', 'dsh', 'goose', 'hermes']),
    );
    expect(listPublicAdapterNames()).not.toContain('stub');
  });

  test('agent run --help lists every public adapter and not stub', () => {
    const program = new Command();
    registerAgent(program);
    const agent = program.commands.find((c) => c.name() === 'agent');
    const run = agent.commands.find((c) => c.name() === 'run');
    const adapter = run.options.find((o) => o.long === '--adapter');
    expect(adapter.description).toContain(`(${listPublicAdapterNames().join('|')})`);
    expect(adapter.description).not.toContain('stub');
  });

  test('agent attach describes every public adapter and not stub', () => {
    const program = new Command();
    registerAgent(program);
    const agent = program.commands.find((c) => c.name() === 'agent');
    const attach = agent.commands.find((c) => c.name() === 'attach');
    expect(attach.description()).toContain(`(${listPublicAdapterNames().join('|')})`);
    expect(attach.description()).not.toContain('stub');
  });
});
