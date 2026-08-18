/**
 * Command registration smoke.
 *
 * Why this file exists: `registerAgent` builds its option list at module-eval
 * time, and every other suite imports `performRun` (or a sibling) directly —
 * so nothing in 302 passing tests ever ran the code that wires the commands up.
 * A `.option()` whose help string interpolated an unimported constant threw
 * `ReferenceError` on the first line of `commonly`, with the whole suite green.
 * On this fleet that is a crash-loop on restart, not a bad error message.
 *
 * The assertions are deliberately shallow. This is a "does the binary come up"
 * probe, not a test of what any flag does — those live next to the behaviour.
 */

import { Command } from 'commander';
import { registerAgent } from '../src/commands/agent.js';
import { CASCADE_ENV_VARS } from '../src/lib/enforcement.js';

const registerAll = () => {
  const program = new Command();
  program.exitOverride();
  registerAgent(program);
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
