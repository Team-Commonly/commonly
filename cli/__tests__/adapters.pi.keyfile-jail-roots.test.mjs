/**
 * adapters.pi.keyfile-jail-roots.test.mjs: a public pi seat's provider
 * keyFile must sit where the jail cannot read it.
 *
 * The proxy reads the key file in this process, so the file never needs to be
 * inside the jail, and it should not be readable there. The Seatbelt baseline admits more than the seat's own directories:
 * system trees like /etc, /private/etc, /opt/homebrew/lib and /usr/local/lib
 * are readable inside it. The refusal reads those roots from the profile
 * itself (seatbeltSystemReadRoots), so the check cannot drift from what the
 * jail allows.
 */
import { realpathSync } from 'fs';
import { refuseKeyFileInJail } from '../src/lib/adapters/pi.js';
import { seatbeltSystemReadRoots } from '../src/lib/sandbox/seatbelt.js';

describe('seatbeltSystemReadRoots reads what the baseline lets a jail read', () => {
  const roots = seatbeltSystemReadRoots();

  test('the system trees a key file could plausibly sit in', () => {
    for (const dir of ['/etc', '/private/etc', '/opt/homebrew/lib', '/opt/homebrew/Cellar', '/opt/homebrew/opt',
      '/usr/local/lib', '/usr/local/bin', '/Library/Preferences', '/usr/share', '/private/var/db']) {
      expect(roots.subpaths).toContain(dir);
    }
  });

  test('single readable files are literals, not trees', () => {
    expect(roots.literals).toContain('/private/etc/passwd');
    expect(roots.literals).toContain('/opt/homebrew/etc/ca-certificates/cert.pem');
    // `/` is readable as a directory listing only: nothing below it.
    expect(roots.literals).toContain('/');
    expect(roots.subpaths).not.toContain('/');
  });

  test('metadata-only and write-only grants are not reads', () => {
    // file-read-metadata on /var and /tmp lets a jail stat, not read.
    expect(roots.subpaths).not.toContain('/var');
    expect(roots.subpaths).not.toContain('/private/var');
    expect(roots.literals).not.toContain('/tmp');
    expect(roots.subpaths).not.toContain('/tmp');
    expect(roots.subpaths).not.toContain('/private/tmp');
  });
});

describe('refuseKeyFileInJail', () => {
  const ownDirs = [];

  test.each([
    '/etc/litellm.key',
    '/private/etc/litellm.key',
    '/opt/homebrew/lib/keys/provider.key',
    '/opt/homebrew/etc/openssl@3/provider.key',
    '/usr/local/lib/provider.key',
    '/Library/Preferences/provider.key',
    '/private/var/db/provider.key',
  ])('refuses a key file under a system tree the jail reads: %s', (keyFile) => {
    expect(() => refuseKeyFileInJail(keyFile, ownDirs)).toThrow(/keyFile .*inside the sandbox of a public seat/);
  });

  test('refuses a key file that is itself a readable literal', () => {
    expect(() => refuseKeyFileInJail('/opt/homebrew/etc/ca-certificates/cert.pem', ownDirs)).toThrow(/inside the sandbox/);
  });

  test.each([
    '/Users/someone/.config/commonly/provider.key',
    '/opt/homebrew/var/provider.key',
    '/usr/local/etc/provider.key',
    '/private/tmp/provider.key',
    '/provider.key',
  ])('accepts a key file the jail cannot read: %s', (keyFile) => {
    expect(() => refuseKeyFileInJail(keyFile, ownDirs)).not.toThrow();
  });

  test('a seat directory that does not exist yet is compared as written, not a crash', () => {
    expect(() => refuseKeyFileInJail('/nonexistent-seat-home/provider.key', ['/nonexistent-seat-home']))
      .toThrow(/move it outside \/nonexistent-seat-home/);
  });

  test('the seat\'s own directories are still checked through their real path', () => {
    // /tmp is /private/tmp on macOS: the key file arrives by its real path.
    const tmp = realpathSync('/tmp');
    expect(() => refuseKeyFileInJail(`${tmp}/seat/provider.key`, ['/tmp'])).toThrow(/inside the sandbox/);
  });
});
