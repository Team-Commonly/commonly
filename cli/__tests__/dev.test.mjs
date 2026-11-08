import { Command } from 'commander';
import { jest } from '@jest/globals';

import { registerDev } from '../src/commands/dev.js';

describe('commonly dev clawdbot', () => {
  test('refuses in plain words, whatever flags an old script passes', async () => {
    const program = new Command();
    registerDev(program);
    const errors = [];
    const error = jest.spyOn(console, 'error').mockImplementation((line) => errors.push(line));
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(program.parseAsync(['dev', 'clawdbot', '--force', '--no-start'], { from: 'user' }))
      .rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toContain('retired (ADR-021 Part B)');
    error.mockRestore();
    exit.mockRestore();
  });
});
