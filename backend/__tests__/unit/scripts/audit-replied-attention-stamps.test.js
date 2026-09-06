// @ts-nocheck

// Only the argv parsing is under test here; the audit itself is covered in
// __tests__/unit/services/attentionItemService.test.js. Stub the modules the
// script pulls in at import time so this needs no database.
jest.mock('mongoose', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock('../../../services/attentionItemService', () => ({ auditRepliedMentionAttention: jest.fn() }));

const { parseArgs } = require('../../../scripts/audit-replied-attention-stamps');

describe('audit-replied-attention-stamps argv', () => {
  it('reads --apply and an ISO bound', () => {
    const { apply, resolvedBefore } = parseArgs(['node', 'script', '--apply', '--resolved-before=2026-09-06T12:42:00Z']);
    expect(apply).toBe(true);
    expect(resolvedBefore.toISOString()).toBe('2026-09-06T12:42:00.000Z');
  });

  it('defaults to a dry run over every replied stamp when no flags are given', () => {
    expect(parseArgs(['node', 'script'])).toEqual({ apply: false });
  });

  // The whole point of the flag is to NARROW the scan to the cutover window.
  // Falling through as `undefined` on a bad value widens it to every replied
  // stamp ever written — under --apply, an unbounded reopen from a typo.
  it.each(['--resolved-before=garbage', '--resolved-before=', '--resolved-before=2026-13-45'])(
    'throws rather than silently widening the scan: %s',
    (flag) => {
      expect(() => parseArgs(['node', 'script', flag])).toThrow(/not a date/);
    },
  );

  // A test for `split('=').slice(1).join('=')` was written here and deleted:
  // no valid date contains an `=`, so truncating at the first one changes
  // nothing a test can observe. It passed against both implementations, which
  // makes it a claim about nothing. The join stays as defensive code.
});
