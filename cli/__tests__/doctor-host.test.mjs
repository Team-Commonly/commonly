import { loginTarget, versionCommand } from '../src/commands/doctor.js';

// The host wiring's two decisions, with config resolution faked. loginTarget
// must agree with createClient (api.js): getToken prefers COMMONLY_TOKEN, and
// resolveInstanceUrl falls back to the default URL when nothing is saved.

const DEFAULT = 'https://api.commonly.me';
const fakes = ({ saved = null, env = {} } = {}) => ({
  env,
  resolve: () => saved,
  resolveUrl: () => saved?.url || DEFAULT,
  tokenFor: () => (env.COMMONLY_TOKEN || saved?.token || null),
});

describe('loginTarget', () => {
  test('a saved login sends the saved token', () => {
    const saved = { key: 'default', url: DEFAULT, token: 'cm_x' };
    expect(loginTarget(fakes({ saved }))).toEqual({
      key: 'default', url: DEFAULT, tokenSource: 'saved', loginHint: 'commonly login',
    });
  });

  test('COMMONLY_TOKEN with nothing saved is a usable login on the default URL, as it is for every command', () => {
    expect(loginTarget(fakes({ env: { COMMONLY_TOKEN: 'cm_env' } }))).toMatchObject({
      key: null, url: DEFAULT, tokenSource: 'env',
    });
  });

  test('COMMONLY_TOKEN beside a saved login is the token sent, and is named as such', () => {
    const saved = { key: 'default', url: DEFAULT, token: 'cm_saved' };
    expect(loginTarget(fakes({ saved, env: { COMMONLY_TOKEN: 'cm_env' } })).tokenSource).toBe('env');
  });

  test('nothing saved and no env token is no token, and the hint keeps the --instance given', () => {
    expect(loginTarget({ ...fakes(), instanceArg: 'foo' })).toMatchObject({
      tokenSource: null, loginHint: 'commonly login --instance foo',
    });
  });

  test('never carries the token itself', () => {
    const saved = { key: 'default', url: DEFAULT, token: 'cm_secret' };
    expect(JSON.stringify(loginTarget(fakes({ saved, env: { COMMONLY_TOKEN: 'cm_env_secret' } })))).not.toMatch(/cm_/);
  });
});

describe('versionCommand', () => {
  test('a Windows .cmd shim goes through the shell, quoted', () => {
    expect(versionCommand('C:\\Program Files\\nodejs\\commonly.cmd', 'win32')).toEqual({
      command: '"C:\\Program Files\\nodejs\\commonly.cmd" --version', args: [], shell: true,
    });
  });

  test('everything else is spawned directly', () => {
    expect(versionCommand('/opt/homebrew/bin/commonly', 'darwin')).toEqual({
      command: '/opt/homebrew/bin/commonly', args: ['--version'], shell: false,
    });
    expect(versionCommand('C:\\npm\\commonly.exe', 'win32').shell).toBe(false);
  });
});
