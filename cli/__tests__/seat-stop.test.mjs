/**
 * seat-stop: SIGTERM keeps the turn, and arms a supervised-group kill a margin
 * before the seat plist's ExitTimeOut (launchd's SIGKILL). The plist is only
 * read. The process-level behaviour is covered with real processes in
 * packages/seats/test/supervisor-tree-and-deadline.test.js.
 */
import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_EXIT_TIMEOUT_S, createSeatStop, groupKillDeadlineMs, readExitTimeOut, readSeatPlist, seatPlistPath,
} from '../src/lib/seat-stop.js';

const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>me.commonly.seat-anvil</string>
  <key>KeepAlive</key>
  <true/>
${body}
</dict>
</plist>
`;

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'seat-stop-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const writePlist = (name, body) => {
  const path = seatPlistPath(name, home);
  writeFileSync(path, plist(body));
  return path;
};

describe('seat-stop — ExitTimeOut', () => {
  test('the plist path is the seat launch agent', () => {
    expect(seatPlistPath('anvil', home)).toBe(join(home, 'Library', 'LaunchAgents', 'me.commonly.seat-anvil.plist'));
    expect(seatPlistPath('../x', home)).toBeNull();
    expect(seatPlistPath('a/b', home)).toBeNull();
  });

  test('reads ExitTimeOut from an XML plist, and only reads it', () => {
    const path = writePlist('anvil', '  <key>ExitTimeOut</key>\n  <integer>40</integer>');
    const before = readFileSync(path, 'utf8');
    expect(readExitTimeOut(path)).toBe(40);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('unset, zero, missing file and no path all read as unset', () => {
    expect(readExitTimeOut(writePlist('a', ''))).toBeNull();
    expect(readExitTimeOut(writePlist('b', '  <key>ExitTimeOut</key>\n  <integer>0</integer>'))).toBeNull();
    expect(readExitTimeOut(join(home, 'nope.plist'))).toBeNull();
    expect(readExitTimeOut(null)).toBeNull();
  });

  test('a binary plist is read through plutil -extract', () => {
    const run = jest.fn(() => ({ status: 0, stdout: '30\n' }));
    const value = readExitTimeOut('/x.plist', { readFile: () => Buffer.from('bplist00...'), run });
    expect(value).toBe(30);
    expect(run).toHaveBeenCalledWith('plutil', ['-extract', 'ExitTimeOut', 'raw', '-o', '-', '/x.plist'], expect.any(Object));
  });

  test('the deadline is ExitTimeOut less min(5 s, a quarter); unset means 20 s', () => {
    expect(DEFAULT_EXIT_TIMEOUT_S).toBe(20);
    expect(groupKillDeadlineMs(null)).toBe(15000);
    expect(groupKillDeadlineMs(40)).toBe(35000);
    expect(groupKillDeadlineMs(4)).toBe(3000);
    for (const s of [1, 4, 20, 40, 120]) expect(groupKillDeadlineMs(s)).toBeLessThan(s * 1000);
  });
});

describe('seat-stop — requestStop', () => {
  const make = (name = 'anvil') => {
    const stop = jest.fn();
    const arm = jest.fn();
    const kill = jest.fn();
    return { stop, arm, kill, seatStop: createSeatStop({ name, stop, home, deps: { arm, kill } }) };
  };

  test('SIGTERM stops the loop and arms the group kill before ExitTimeOut', () => {
    writePlist('anvil', '  <key>ExitTimeOut</key>\n  <integer>8</integer>');
    const { stop, arm, kill, seatStop } = make();
    expect(seatStop.requestStop('SIGTERM')).toBe(6000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith(6000);
    expect(kill).not.toHaveBeenCalled();
  });

  test('SIGTERM on a seat with no plist (daemon-spawned) arms nothing: the exit path alone kills', () => {
    const { stop, arm, seatStop } = make('daemon-seat');
    expect(seatStop.requestStop('SIGTERM')).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
  });

  test('SIGTERM on a seat whose plist has no ExitTimeOut uses launchd\'s 20 s default', () => {
    writePlist('anvil', '');
    const { arm, seatStop } = make();
    expect(seatStop.requestStop('SIGTERM')).toBe(15000);
    expect(arm).toHaveBeenCalledWith(15000);
  });

  test('a plist that exists but cannot be read still counts as present, at the default', () => {
    expect(readSeatPlist('/p.plist', { exists: () => true, readFile: () => { throw new Error('EACCES'); } }))
      .toEqual({ present: true, exitTimeOut: null });
    expect(readSeatPlist(join(home, 'nope.plist'))).toEqual({ present: false, exitTimeOut: null });
    expect(readSeatPlist(null)).toEqual({ present: false, exitTimeOut: null });
  });

  test('SIGINT stops the loop and arms nothing', () => {
    const { stop, arm, seatStop } = make();
    expect(seatStop.requestStop('SIGINT')).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
  });

  test('the exit path kills the supervised groups', () => {
    const { kill, seatStop } = make();
    seatStop.onExit();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
