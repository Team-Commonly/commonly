const { composeStalledConnectNotice } = require('../../../services/stalledConnectCopy');

// F666: the installer's private row names the agent and points at its panel,
// where the start command already lives for them alone. It never carries a
// command, whichever way it points.
describe('the stalled-connect row', () => {
  it('names the agent in the title', () => {
    expect(composeStalledConnectNotice({ displayName: 'Rivet' }).title).toBe("Rivet hasn't connected yet");
  });

  it('sends an agent whose key is only on the page to Connect in its panel', () => {
    const { detail } = composeStalledConnectNotice({ displayName: 'Rivet', connectable: true });
    expect(detail).toContain('press Connect in its panel');
  });

  it('points an agent with a saved key at the start command in its panel', () => {
    const { detail } = composeStalledConnectNotice({ displayName: 'Rivet', connectable: false });
    expect(detail).toContain('its panel has the command that starts it');
    expect(detail).not.toContain('Connect');
  });

  it.each([true, false])('carries no command (connectable=%p)', (connectable) => {
    const { title, detail } = composeStalledConnectNotice({ displayName: 'Rivet', connectable });
    expect(`${title} ${detail}`).not.toMatch(/npx|agent run|`/);
  });
});
