/**
 * F647: a confined Claude seat's HOME is its own folder, whose
 * Library/Keychains is a link to the person's real one. Seatbelt checks the
 * path the link resolves to, so the profile admits that resolved login
 * keychain too, and only when it sits in the person's own Library/Keychains.
 * Temp folders stand in for both homes; no real keychain is read.
 */
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';

const escape = (path) => path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

describe('Seatbelt profile with a linked seat keychain (F647)', () => {
  let root;
  let workspace;
  let state;

  // The person's home is reached through a link, so the keychain's resolved
  // path always differs from the one the base rule names. Without it the test
  // would lean on the temp folder itself sitting behind a link, which holds on
  // macOS (/var -> /private/var) but not on Linux.
  const makePersonHome = (name) => {
    const home = join(root, 'homes', name);
    const keychains = join(home, 'Library', 'Keychains');
    mkdirSync(keychains, { recursive: true });
    writeFileSync(join(keychains, 'login.keychain-db'), 'not a real keychain');
    return home;
  };

  const linkSeatKeychains = (target) => {
    mkdirSync(join(state, 'Library'), { recursive: true });
    symlinkSync(target, join(state, 'Library', 'Keychains'));
  };

  const profileFor = (personHome) => buildSeatbeltProfile({
    workspacePath: workspace,
    executablePath: '/usr/bin/true',
    statePath: state,
    allowClaudeRuntimeAccess: true,
    keychainHome: personHome,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'commonly-f647-'));
    workspace = join(root, 'workspace');
    state = join(root, 'state');
    mkdirSync(workspace);
    mkdirSync(state);
    mkdirSync(join(root, 'real-homes'));
    symlinkSync(join(root, 'real-homes'), join(root, 'homes'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a linked Keychains folder admits the resolved login keychain, that file only', () => {
    const personHome = makePersonHome('person');
    linkSeatKeychains(join(personHome, 'Library', 'Keychains'));
    const resolved = realpathSync(join(personHome, 'Library', 'Keychains', 'login.keychain-db'));
    expect(resolved).not.toBe(join(personHome, 'Library', 'Keychains', 'login.keychain-db'));

    const profile = profileFor(personHome);

    expect(profile).toContain(`(allow file-read* file-test-existence (literal "${escape(resolved)}"))`);
    expect(profile).toContain(`(allow file-read-metadata file-test-existence (path-ancestors "${escape(resolved)}"))`);
    // Never the folder, never the person's Library.
    expect(profile).not.toContain(`(subpath "${escape(realpathSync(join(personHome, 'Library', 'Keychains')))}")`);
    expect(profile).not.toContain(`(subpath "${escape(realpathSync(join(personHome, 'Library')))}")`);
  });

  test('a link whose target is outside the person\'s Library/Keychains adds no rule', () => {
    const personHome = makePersonHome('person');
    const elsewhere = join(root, 'elsewhere', 'Keychains');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'login.keychain-db'), 'not a real keychain');
    linkSeatKeychains(elsewhere);

    const profile = profileFor(personHome);

    // The person's own login keychain is the one keychain the profile names...
    expect(profile).toContain(
      `(literal "${escape(join(personHome, 'Library', 'Keychains', 'login.keychain-db'))}")`,
    );
    // ...and the link's outside target appears nowhere in it.
    expect(profile).not.toContain(escape(realpathSync(elsewhere)));
    expect(profile).not.toContain(escape(elsewhere));
  });

  test('a resolved path holding a quote or a space is escaped', () => {
    const personHome = makePersonHome('person "quoted" home');
    linkSeatKeychains(join(personHome, 'Library', 'Keychains'));
    const resolved = realpathSync(join(personHome, 'Library', 'Keychains', 'login.keychain-db'));
    expect(resolved).toContain('"');
    expect(resolved).not.toBe(join(personHome, 'Library', 'Keychains', 'login.keychain-db'));

    const profile = profileFor(personHome);

    expect(profile).toContain(`(allow file-read* file-test-existence (literal "${escape(resolved)}"))`);
    expect(escape(resolved)).toContain('person \\"quoted\\" home');
    // The raw, unescaped quote never reaches the profile.
    expect(profile).not.toContain(`"${resolved}"`);
  });
});
