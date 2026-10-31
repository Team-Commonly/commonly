import {
  renderDaemonWatch, safeLogLine, shouldRedraw, CLEAR_SCREEN, WATCH_INTERVAL_MS,
} from '../src/lib/daemon-watch.js';
import { seatKey } from '../src/lib/daemon-agent-states.js';

const NOW = Date.parse('2026-10-31T23:00:00Z');
const machine = { name: 'Sam MacBook', status: 'online', lastSeenAt: '2026-10-31T22:59:50Z' };
const seats = [
  { agentName: 'dart', instanceId: 'dart', state: 'running', lastTurnAt: '2026-10-31T22:58:00Z', lastError: null },
  { agentName: 'nova', instanceId: 'default', state: 'stopped', lastTurnAt: '2026-10-31T20:00:00Z', lastError: null },
  { agentName: 'pixel', instanceId: 'default', state: 'crashed', lastTurnAt: null, lastError: 'child exited with code 1' },
];
const logTails = { dart: ['turn one done', 'turn two started'] };
const states = new Map([
  [seatKey('dart', 'dart'), 'running'],
  [seatKey('nova', 'default'), 'not connected'],
  [seatKey('pixel', 'default'), 'stalled'],
]);

describe('renderDaemonWatch', () => {
  test('shows the machine, then one block per agent with the server state, last turn and error', () => {
    const text = renderDaemonWatch({ machine, seats, logTails, states, now: NOW, width: 80 });
    expect(text).toMatch(/^Sam MacBook: online\nlast heartbeat 10s ago/);
    expect(text).toContain('dart  running  last turn 2m ago');
    expect(text).toContain('nova  not connected  last turn 3h ago');
    expect(text).toContain('pixel  stalled  last turn never');
    expect(text).toContain('  error: child exited with code 1');
    expect(text).toContain('  turn one done');
  });

  test('an agent the verdict does not list reads not registered; with no verdict it reads local', () => {
    const text = renderDaemonWatch({ machine, seats: [seats[0]], states: new Map(), now: NOW });
    expect(text).toContain('dart  not registered');
    const noLogin = renderDaemonWatch({
      machine, seats: [seats[0]], states: null, stateNote: 'Not logged in: showing local process state only.', now: NOW,
    });
    expect(noLogin).toContain('dart  local running  last turn 2m ago');
    expect(noLogin).toContain('Not logged in: showing local process state only.');
    expect(noLogin).not.toMatch(/dart  (running|stalled|not connected)/);
  });

  test('a narrow 80-column layout clips long lines to the width', () => {
    const long = 'x'.repeat(200);
    const text = renderDaemonWatch({
      machine, seats: [{ agentName: 'dart', instanceId: 'dart', state: 'crashed', lastError: long }],
      logTails: { dart: [long] }, states, now: NOW, width: 80,
    });
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  test('a wide 180-column layout keeps the same content without clipping short lines', () => {
    const text = renderDaemonWatch({ machine, seats, logTails, states, now: NOW, width: 180 });
    expect(text).toContain('dart  running  last turn 2m ago');
    expect(text).toContain('  error: child exited with code 1');
  });

  test('a colour render wraps the agent name and log lines in ANSI, a plain one does not', () => {
    const colour = renderDaemonWatch({ machine, seats, logTails, states, now: NOW, width: 80, color: true });
    const plain = renderDaemonWatch({ machine, seats, logTails, states, now: NOW, width: 80, color: false });
    expect(colour).toContain('\x1b[2m');
    expect(plain).not.toContain('\x1b[');
  });

  test('says so when no agents are supervised', () => {
    expect(renderDaemonWatch({ machine, seats: [], now: NOW })).toContain('No supervised agents on this machine.');
  });
});

describe('safeLogLine', () => {
  test('redacts token shapes and clips to the width', () => {
    const line = 'auth cm_daemon_abc123DEF and Bearer sekret-value and more text';
    const out = safeLogLine(line, 60);
    expect(out).not.toContain('abc123DEF');
    expect(out).not.toContain('sekret-value');
    expect(out).toContain('[redacted]');
    expect(out.length).toBeLessThanOrEqual(60);
  });
});

describe('safeLogLine terminal and credential boundary', () => {
  test('strips OSC, CSI and bare escape sequences and C0 controls, and keeps the text', () => {
    expect(safeLogLine('\x1b]52;c;SGVsbG8=\x07ok\x1b[2Jend', 80)).toBe('okend');
    expect(safeLogLine('a\x1bMb\x07c', 80)).toBe('abc');
    expect(safeLogLine('a\tb\rc', 80)).toBe('a  bc');
  });

  test('redacts Authorization headers and quoted or bare credential fields', () => {
    expect(safeLogLine('req Authorization: Basic dXNlcjpwYXNz ok', 80)).toBe('req Authorization: [redacted] ok');
    expect(safeLogLine('{"token": "abc123", "x":1}', 80)).toBe('{"token": "[redacted]", "x":1}');
    expect(safeLogLine('password=hunter2 done', 80)).toBe('password=[redacted] done');
  });

  test('applies the same boundary to the seat error and the note', () => {
    const text = renderDaemonWatch({
      machine: { name: 'm', status: 'online', lastSeenAt: null },
      seats: [{ agentName: 'dart', instanceId: 'dart', state: 'crashed', lastError: '\x1b[31mtoken=zzz' }],
      stateNote: 'Note \x1b]0;title\x07 here', now: NOW, width: 80,
    });
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('zzz');
  });
});

describe('shouldRedraw', () => {
  test('redraws only on a terminal without NO_COLOR', () => {
    expect(shouldRedraw({ isTTY: true, env: {} })).toBe(true);
    expect(shouldRedraw({ isTTY: false, env: {} })).toBe(false);
    expect(shouldRedraw({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
  });

  test('a set-but-empty NO_COLOR is ignored, per the no-color convention', () => {
    expect(shouldRedraw({ isTTY: true, env: { NO_COLOR: '' } })).toBe(true);
  });
});

describe('watch constants', () => {
  test('redraws every 2 seconds and clears from home', () => {
    expect(WATCH_INTERVAL_MS).toBe(2000);
    expect(CLEAR_SCREEN.startsWith('\x1b[H')).toBe(true);
  });
});
