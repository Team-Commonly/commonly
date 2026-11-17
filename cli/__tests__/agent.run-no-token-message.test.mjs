/**
 * F548: the four Windows lines pasted into Command Prompt run the install and
 * the run line, but the `$env:` lines set nothing there, so `agent run` finds
 * no token and exits before it reaches the server. Its message said "export",
 * which is neither shell's word for it.
 */
import { noRunTokenMessage } from '../src/commands/agent.js';

describe('agent run: the message when no token is set (F548)', () => {
  it('on Windows, sends the person to PowerShell and shows the $env: lines', () => {
    const message = noRunTokenMessage({ name: 'scout', platform: 'win32' });
    expect(message).toMatch(/PowerShell/);
    expect(message).toMatch(/not Command Prompt/);
    expect(message).toContain('$env:COMMONLY_API_URL="…"');
    expect(message).toContain('$env:COMMONLY_AGENT_TOKEN="…"');
    expect(message).not.toMatch(/\bexport\b/);
  });

  it.each([['darwin'], ['linux']])('on %s, says what it said before', (platform) => {
    expect(noRunTokenMessage({ name: 'scout', agentArg: 'scout', platform }).replace(/^No token for 'scout'\. /, '').replace(/\S+ agent attach/, 'CLI agent attach'))
      .toBe('Either export COMMONLY_API_URL + COMMONLY_AGENT_TOKEN (shown on the Connect your own agent page) and re-run,'
        + ' or: CLI agent attach <adapter> --pod <podId> --name scout');
  });

  it('names the agent and the attach fallback on every platform', () => {
    for (const platform of ['win32', 'darwin']) {
      const message = noRunTokenMessage({ name: 'scout', platform });
      expect(message).toContain("No token for 'scout'");
      expect(message).toMatch(/agent attach <adapter> --pod <podId> --name scout/);
    }
  });
});
