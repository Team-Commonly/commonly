/**
 * Command registration smoke.
 *
 * Why this file exists: `registerAgent` is a function (`agent.js:1373`) and
 * every `.option()` call sits INSIDE it, so the option list — and the template
 * literals in its help strings — is built when the CLI calls it, not when the
 * module is imported. Every other suite imports `performRun` (a sibling export
 * of the same module) directly and never calls `registerAgent`, so nothing in
 * 302 passing tests ever ran the code that wires the commands up.
 *
 * That is precisely why the gap was invisible: a `.option()` whose help string
 * interpolated an unimported constant threw `ReferenceError` on the first line
 * of `commonly` while the whole suite stayed green. Module-eval would have been
 * the safer failure — importing `performRun` would have thrown too, and the 302
 * would have gone red the moment the bug landed. On this fleet the real thing
 * is a crash-loop on restart, not a bad error message.
 *
 * The assertions are deliberately shallow. This is a "does the binary come up"
 * probe, not a test of what any flag does — those live next to the behaviour.
 */

import { Command } from 'commander';
import { cascadeOverridesFromOpts, registerAgent } from '../src/commands/agent.js';
import { registerDaemon } from '../src/commands/daemon.js';
import { CASCADE_ENV_VARS } from '../src/lib/enforcement.js';

const registerAll = () => {
  const program = new Command();
  program.exitOverride();
  registerAgent(program);
  registerDaemon(program);
  return program;
};

const findCommand = (program, path) => path.reduce(
  (node, name) => node?.commands.find((c) => c.name() === name),
  program,
);

describe('command registration', () => {
  test('registerAgent evaluates every option definition without throwing', () => {
    expect(() => registerAll()).not.toThrow();
  });

  test('daemon registration commands are wired without starting a daemon', () => {
    const daemon = findCommand(registerAll(), ['daemon']);
    expect(daemon).toBeDefined();
    expect(daemon.commands.map((command) => command.name())).toEqual(expect.arrayContaining([
      'register', 'heartbeat', 'status',
    ]));
    expect(findCommand(registerAll(), ['daemon', 'register']).options.map((option) => option.long))
      .toEqual(expect.arrayContaining(['--name', '--instance']));
  });

  test('agent run exposes the cascade knobs, each naming its env var', () => {
    const run = findCommand(registerAll(), ['agent', 'run']);
    expect(run).toBeDefined();

    const flags = run.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining([
      '--interval', '--cascade-cap', '--cascade-grace', '--cascade-reset',
    ]));

    // The help text is the only place an operator learns the env name, so a
    // renamed constant that stops reaching the help is a real regression.
    const help = run.options.map((o) => o.description).join('\n');
    for (const envVar of Object.values(CASCADE_ENV_VARS)) {
      expect(help).toContain(envVar);
    }
  });

  test('a cascade flag reaches the run params under the right key, uncoerced', () => {
    // Three renamings sit between what the operator types and what the
    // resolver validates: --cascade-grace -> opts.cascadeGrace ->
    // cascadeAddressedGrace. Nothing else parses these flags, so a slip in
    // that chain reads as "the flag does nothing" with every other test green.
    const run = findCommand(registerAll(), ['agent', 'run']);
    const probe = new Command();
    probe.exitOverride();
    for (const option of run.options) probe.addOption(option);
    probe.parse(['--cascade-cap', 'abc', '--cascade-grace', '4'], { from: 'user' });

    const overrides = cascadeOverridesFromOpts(probe.opts());
    // Strings, not numbers: the resolver is the only thing that parses, so it
    // can quote a bad value back the way the operator typed it.
    expect(overrides.cascadeCap).toBe('abc');
    expect(overrides.cascadeAddressedGrace).toBe('4');
    // Unpassed stays undefined, or it would shadow the env var.
    expect(overrides.cascadeResetMs).toBeUndefined();
  });

  test('the cascade flags carry no commander default, so env still gets its turn', () => {
    // A commander default would make `opts.cascadeCap` always defined, and the
    // run loop treats "defined" as an explicit override — silently shadowing
    // the environment for every seat.
    const run = findCommand(registerAll(), ['agent', 'run']);
    for (const long of ['--cascade-cap', '--cascade-grace', '--cascade-reset']) {
      const option = run.options.find((o) => o.long === long);
      expect(option.defaultValue).toBeUndefined();
    }
  });
});
