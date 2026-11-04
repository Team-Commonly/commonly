import {
  savedRuntimeControls, withSavedRuntimeControls, effortRefusedByDevice,
} from '../src/lib/seat-runtime-controls.js';

describe('seat runtime controls (D247)', () => {
  test('an effort passes through when the device reported no levels', () => {
    expect(effortRefusedByDevice({ models: null, efforts: [] }, 'xhigh')).toBe(false);
    expect(effortRefusedByDevice(null, 'xhigh')).toBe(false);
    expect(effortRefusedByDevice({ efforts: ['low', 'high'] }, 'high')).toBe(false);
    expect(effortRefusedByDevice({ efforts: ['low', 'high'] }, 'xhigh')).toBe(true);
    expect(effortRefusedByDevice({ efforts: ['low'] }, undefined)).toBe(false);
  });

  test('reads the saved controls for this pod and instance, falling back to any row that has them', () => {
    const installations = [
      { type: 'installation', podId: 'p1', instanceId: 'default', runtimeControls: {} },
      { type: 'installation', podId: 'p2', instanceId: 'default', runtimeControls: { model: 'gpt-6-sol', effort: 'max' } },
      { type: 'dm', podId: 'p3', runtimeControls: { model: 'nope' } },
    ];
    expect(savedRuntimeControls({ installations, podId: 'p2', instanceId: 'default' }))
      .toEqual({ model: 'gpt-6-sol', effort: 'max' });
    // An empty row in this pod doesn't hide the controls saved on the other one.
    expect(savedRuntimeControls({ installations, podId: 'p1', instanceId: 'default' }))
      .toEqual({ model: 'gpt-6-sol', effort: 'max' });
    expect(savedRuntimeControls({ installations: [installations[0]], podId: 'p1', instanceId: 'default' })).toBeNull();
    expect(savedRuntimeControls({ installations, podId: 'p9', instanceId: 'default' }))
      .toEqual({ model: 'gpt-6-sol', effort: 'max' });
    expect(savedRuntimeControls({ installations: [{ type: 'installation', podId: 'p1' }], podId: 'p1' })).toBeNull();
    expect(savedRuntimeControls({ installations: undefined })).toBeNull();
  });

  test('saved controls replace the record\'s, and a missing environment stays missing', () => {
    const environment = { model: 'old', sandbox: { trust: 'public' } };
    expect(withSavedRuntimeControls(environment, { effort: 'high' }))
      .toEqual({ model: 'old', effort: 'high', sandbox: { trust: 'public' } });
    expect(withSavedRuntimeControls(environment, null)).toBe(environment);
    expect(withSavedRuntimeControls(null, { model: 'x' })).toBeNull();
  });
});
