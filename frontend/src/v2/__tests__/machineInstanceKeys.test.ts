import { keepsInstanceKeys, INSTANCE_KEYS_CLI_VERSION } from '../utils/machineInstanceKeys';

// F427: CLI 0.1.328 is the first daemon that keeps a local key per instance.
describe('keepsInstanceKeys', () => {
  test('the first version and every later one', () => {
    expect(INSTANCE_KEYS_CLI_VERSION).toBe('0.1.328');
    for (const v of ['0.1.328', '0.1.329', '0.1.1000', '0.2.0', '1.0.0', '0.1.329-rc.1']) {
      expect(keepsInstanceKeys(v)).toBe(true);
    }
  });

  test('older versions, a prerelease of the first, and anything not a version', () => {
    for (const v of ['0.1.327', '0.1.99', '0.0.999', '0.1.328-rc.1', '', 'latest', '0.1', null, undefined]) {
      expect(keepsInstanceKeys(v)).toBe(false);
    }
  });
});
