// F133: the command half of the chat-relay core that Discord now shares with
// Telegram: one parse, mute durations with units, and the authority gate on
// every settings write.
const { applyRelayCommand, parseRelayCommand } = require('../../../services/chatRelay/chatRelayCore');

const NOW = new Date('2026-11-04T12:00:00Z');
const MIN = 60_000;
const integration = { _id: 'i', config: { relayAllAgentMessages: false } };

describe('parseRelayCommand', () => {
  test('names a bridge command in any case, and lowercases only the mode', () => {
    expect(parseRelayCommand('MODE', ' Mirror ')).toEqual({ name: 'mode', arg: 'mirror' });
    expect(parseRelayCommand('mute', '2H')).toEqual({ name: 'mute', arg: '2H' });
    expect(parseRelayCommand('status')).toEqual({ name: 'status' });
    expect(parseRelayCommand('unmute')).toEqual({ name: 'unmute' });
    expect(parseRelayCommand('help')).toEqual({ name: 'help' });
  });

  test('anything else is not a bridge command', () => {
    expect(parseRelayCommand('tldr')).toBeNull();
    expect(parseRelayCommand('')).toBeNull();
    expect(parseRelayCommand(undefined)).toBeNull();
  });
});

test.each([
  ['30m', 30], ['30 min', 30], ['2h', 120], ['1 hour', 60], ['48h', 1440], ['45', 45], ['0m', 60],
  [' 2h ', 120],
])('mute %p is %i minutes', (arg, minutes) => {
  const outcome = applyRelayCommand({ name: 'mute', arg }, integration, NOW);
  expect(outcome).toMatchObject({ kind: 'mute', minutes, until: new Date(NOW.getTime() + minutes * MIN) });
});

// ReDoS guard (#3469): a long run of whitespace before an unreadable unit must
// stay linear. Since F161 an unreadable duration is usage, not the default.
test('a 50,000-tab duration is usage, answered quickly', () => {
  const arg = '0' + '\t'.repeat(50000) + 'x';
  const started = process.hrtime.bigint();
  const outcome = applyRelayCommand({ name: 'mute', arg }, integration, NOW);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  expect(outcome).toEqual({ kind: 'mute-usage' });
  expect(elapsedMs).toBeLessThan(50);
});

describe('the authority gate', () => {
  test.each([
    [{ name: 'mode', arg: 'mirror' }],
    [{ name: 'mute', arg: '30' }],
    [{ name: 'unmute' }],
  ])('a write %p without authority is refused and carries no update', (command) => {
    const outcome = applyRelayCommand(command, integration, NOW, { mayChangeSettings: false });
    expect(outcome).toEqual({ kind: 'refused', command: command.name });
  });

  test('reads pass without authority', () => {
    expect(applyRelayCommand({ name: 'status' }, integration, NOW, { mayChangeSettings: false }).kind).toBe('status');
    expect(applyRelayCommand({ name: 'mode' }, integration, NOW, { mayChangeSettings: false }).kind).toBe('mode-show');
    expect(applyRelayCommand({ name: 'help' }, null, NOW, { mayChangeSettings: false }).kind).toBe('help');
  });

  test('with authority, or with none asked for, the write goes through', () => {
    expect(applyRelayCommand({ name: 'unmute' }, integration, NOW, { mayChangeSettings: true }).kind).toBe('unmute');
    expect(applyRelayCommand({ name: 'unmute' }, integration, NOW).kind).toBe('unmute');
  });
});
