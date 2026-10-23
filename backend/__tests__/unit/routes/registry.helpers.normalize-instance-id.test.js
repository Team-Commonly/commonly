const { normalizeInstanceId } = require('../../../routes/registry/helpers');

it('collapses separators and trims the edges of an instance ID', () => {
  expect(normalizeInstanceId('  ---Machine -- 2---  ')).toBe('machine-2');
  expect(normalizeInstanceId('---')).toBe('default');
  expect(normalizeInstanceId(null)).toBe('default');
});
