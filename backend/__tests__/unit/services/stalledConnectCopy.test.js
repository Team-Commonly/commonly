const { composeStalledConnectNudge } = require('../../../services/stalledConnectCopy');

const ISSUED = new Date('2026-11-01T10:00:00Z');
const COPIED = new Date('2026-11-01T10:01:00Z');
const compose = (evidence, connectable) => composeStalledConnectNudge({
  installerName: 'alice',
  displayName: 'Rivet',
  handle: 'rivet',
  fixCommand: 'commonly agent run rivet',
  connectable,
  evidence: { tokenIssuedAt: ISSUED, ...evidence },
});

describe('the nudge for an agent whose key is only on the page', () => {
  it.each([
    ['nothing copied', {}],
    ['the listener copied', { cliCopiedAt: COPIED }],
    ['the MCP command copied', { mcpCopiedAt: COPIED }],
    ['the listener copied on Linux', { cliCopiedAt: COPIED, openedOs: 'linux' }],
    ['the MCP command copied on Linux', { mcpCopiedAt: COPIED, openedOs: 'linux' }],
    ['the listener copied on Windows', { cliCopiedAt: COPIED, openedOs: 'windows' }],
    ['the MCP command copied on Windows', { mcpCopiedAt: COPIED, openedOs: 'windows' }],
  ])('with %s, goes through Connect and never the bare command', (_label, evidence) => {
    const text = compose(evidence, true);
    expect(text).toContain('my Settings');
    expect(text).toContain('press Connect');
    expect(text).not.toContain('commonly agent run');
    expect(text).not.toContain('the page’s lines again');
  });

  it.each([
    ['nothing copied', {}],
    ['the listener copied', { cliCopiedAt: COPIED }],
    ['the MCP command copied', { mcpCopiedAt: COPIED }],
    ['the listener copied on Linux', { cliCopiedAt: COPIED, openedOs: 'linux' }],
    ['the MCP command copied on Linux', { mcpCopiedAt: COPIED, openedOs: 'linux' }],
  ])('with %s, an agent with a saved key keeps the command', (_label, evidence) => {
    const text = compose(evidence, false);
    expect(text).toContain('`commonly agent run rivet`');
    expect(text).not.toContain('press Connect');
  });

  it.each([
    ['the listener copied on Windows', { cliCopiedAt: COPIED, openedOs: 'windows' }],
    ['the MCP command copied on Windows', { mcpCopiedAt: COPIED, openedOs: 'windows' }],
  ])('with %s, an agent with a saved key never hears Connect', (_label, evidence) => {
    expect(compose(evidence, false)).not.toContain('press Connect');
  });
});
