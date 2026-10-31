import { machineDisplayName, defaultMachine } from '../utils/machineLabel';

// The label is a function of the list it sits in: the same computer reads
// differently when a same-named sibling exists. t echoes the key and date so the
// assertions read the composed string.
const t = (key: string, options?: Record<string, string>) => `${key.split('.').pop()} ${options?.date ?? ''}`;

const older = { machineId: 'mach-old-1111', name: 'Sams-MacBook', createdAt: '2026-09-06T12:00:00.000Z' };
const newer = { machineId: 'mach-new-2222', name: 'Sams-MacBook', createdAt: '2026-10-24T12:00:00.000Z' };

test('a unique computer name is returned unchanged', () => {
  expect(machineDisplayName(older, [older, { machineId: 'x', name: 'Studio' }], t, 'en')).toBe('Sams-MacBook');
});

test('a shared name gets the date it was added, and the two differ', () => {
  const all = [newer, older];
  const a = machineDisplayName(newer, all, t, 'en');
  const b = machineDisplayName(older, all, t, 'en');
  expect(a).toMatch(/^Sams-MacBook · addedOn Oct 24, /);
  expect(b).toMatch(/^Sams-MacBook · addedOn Sep 6, /);
  expect(a).not.toBe(b);
});

test('zh-CN reads the added date in Chinese, not English', () => {
  const label = machineDisplayName(newer, [newer, older], (key, options) => `添加于 ${options?.date ?? key}`, 'zh-CN');
  // Chinese month and day, no English month. The 12:00Z fixture keeps the date
  // the same from UTC-11 to UTC+11.
  expect(label).toMatch(/^Sams-MacBook · 添加于 10月24日 /);
  expect(label).not.toMatch(/Oct|AM|PM/);
});

test('two computers added in the same minute still get distinct labels', () => {
  const twinA = { machineId: 'mach-aaaa-0001', name: 'Sams-MacBook', createdAt: '2026-10-24T12:00:00.000Z' };
  const twinB = { machineId: 'mach-bbbb-0002', name: 'Sams-MacBook', createdAt: '2026-10-24T12:00:30.000Z' };
  const all = [twinA, twinB];
  expect(machineDisplayName(twinA, all, t, 'en')).toMatch(/ · 0001$/);
  expect(machineDisplayName(twinB, all, t, 'en')).toMatch(/ · 0002$/);
});

test('a shared name with no timestamp falls back to the machine ID tail', () => {
  const undated = { machineId: 'mach-cccc-0003', name: 'Sams-MacBook', createdAt: null };
  expect(machineDisplayName(undated, [undated, newer], t, 'en')).toBe('Sams-MacBook · 0003');
});

test('the default is the first online computer, else the first listed', () => {
  const online = { status: 'online' as const, id: 'a' };
  const offline = { status: 'offline' as const, id: 'b' };
  expect(defaultMachine([offline, online])).toBe(online);
  expect(defaultMachine([offline])).toBe(offline);
});
