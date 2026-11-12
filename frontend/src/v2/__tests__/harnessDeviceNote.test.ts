import { autoDetectedHarness, harnessDeviceNote, harnessSignedOut } from '../utils/harnessCatalog';

const t = (key: string, values: Record<string, string> = {}) => `${key}${JSON.stringify(values)}`;

describe('harnessDeviceNote', () => {
  test('Goose 1.56 says it is not supported in open pods and names the version that works', () => {
    const note = harnessDeviceNote([{ harness: 'goose', installed: true, version: '1.56.0', models: null, efforts: [] }], 'goose', t);
    expect(note).toBe('harness.unsupportedInOpenPods{"version":"1.56.0","works":"Goose 1.54"}');
  });

  test('Goose 1.54, and any other harness, keep the plain installed note', () => {
    expect(harnessDeviceNote([{ harness: 'goose', installed: true, version: '1.54.0', models: null, efforts: [] }], 'goose', t))
      .toBe('harness.installed{"version":"1.54.0"}');
    expect(harnessDeviceNote([{ harness: 'claude', installed: true, version: '1.56.0', models: null, efforts: [] }], 'claude', t))
      .toBe('harness.installed{"version":"1.56.0"}');
    expect(harnessDeviceNote([{ harness: 'goose', installed: true, version: '1.560.1', models: null, efforts: [] }], 'goose', t))
      .toBe('harness.installed{"version":"1.560.1"}');
  });
});

// F458: a computer that reports a harness signed out says so in the picker;
// no verdict reads as plain installed, never as signed out.
describe('signed out', () => {
  const row = (signedIn?: boolean) => ({ harness: 'claude', installed: true, version: '2.1', models: null, efforts: [],
    ...(signedIn === undefined ? {} : { signedIn }) });
  test('the note and the check agree, and the claude-code alias counts', () => {
    expect(harnessDeviceNote([row(false)], 'claude', t)).toBe('harness.signedOut{}');
    expect(harnessDeviceNote([row(true)], 'claude', t)).toBe('harness.installed{"version":"2.1"}');
    expect(harnessDeviceNote([row()], 'claude', t)).toBe('harness.installed{"version":"2.1"}');
    expect(harnessSignedOut([row(false)], 'claude')).toBe(true);
    expect(harnessSignedOut([row(false)], 'claude-code')).toBe(true);
    expect(harnessSignedOut([row()], 'claude')).toBe(false);
    expect(harnessSignedOut([{ ...row(false), installed: false }], 'claude')).toBe(false);
    expect(harnessSignedOut([row(false)], 'codex')).toBe(false);
  });
});

// The daemon's auto-detect order (cli resolveAdapterForRuntime): Claude Code, then Codex.
test('autoDetectedHarness follows the daemon: claude if installed, else codex, else none', () => {
  const row = (harness: string, installed: boolean) => ({ harness, installed, version: null, models: null, efforts: [] });
  expect(autoDetectedHarness([row('codex', true), row('claude', true)])).toBe('claude');
  expect(autoDetectedHarness([row('claude', false), row('codex', true)])).toBe('codex');
  expect(autoDetectedHarness([row('opencode', true)])).toBe('');
  expect(autoDetectedHarness([])).toBe('');
});
