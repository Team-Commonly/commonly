// @ts-nocheck
// The first real digest run (2026-10-17 06:01Z) sent one of its three emails to
// a verified operator account on `@ops.commonly.invalid`, which can never deliver.
import { isReservedEmailDomain } from '../../../utils/reservedEmailDomain';

describe('isReservedEmailDomain', () => {
  test.each([
    'connector-ops@ops.commonly.invalid',
    'a@x.test',
    'a@site.example',
    'a@localhost',
    'A@OPS.COMMONLY.INVALID',
    'a@ops.commonly.invalid.',
  ])('%s is reserved', (email) => {
    expect(isReservedEmailDomain(email)).toBe(true);
  });

  test.each([
    'person@gmail.com',
    'a@invalid.com',
    'a@test-co.io',
    'a@notinvalid',
    'a@example.com',
  ])('%s is an ordinary domain', (email) => {
    expect(isReservedEmailDomain(email)).toBe(false);
  });

  test('anything that is not an address is not reserved', () => {
    expect(isReservedEmailDomain(undefined)).toBe(false);
    expect(isReservedEmailDomain('')).toBe(false);
    expect(isReservedEmailDomain('no-at-sign.invalid')).toBe(false);
  });
});
