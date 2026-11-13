import { runCommandForThisComputer } from '../agentConnection';

// F342: PowerShell resolves a bare `commonly` to the .ps1 shim, which Windows
// 11's default script policy refuses; commonly.cmd runs.
describe('runCommandForThisComputer', () => {
  test('names commonly.cmd on Windows, keeping every flag', () => {
    expect(runCommandForThisComputer('commonly agent run maple --instance-id nova', true))
      .toBe('commonly.cmd agent run maple --instance-id nova');
  });

  test('leaves the line alone off Windows', () => {
    expect(runCommandForThisComputer('commonly agent run maple', false)).toBe('commonly agent run maple');
  });

  test('leaves a sentence that is not a commonly line alone, even on Windows', () => {
    const sentence = 'Run the program behind your webhook URL. A webhook agent has no `commonly` run command.';
    expect(runCommandForThisComputer(sentence, true)).toBe(sentence);
  });

  test('does not double the suffix', () => {
    expect(runCommandForThisComputer('commonly.cmd agent run maple', true)).toBe('commonly.cmd agent run maple');
  });
});
