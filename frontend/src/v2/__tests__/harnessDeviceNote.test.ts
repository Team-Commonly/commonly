import { harnessDeviceNote } from '../utils/harnessCatalog';

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
