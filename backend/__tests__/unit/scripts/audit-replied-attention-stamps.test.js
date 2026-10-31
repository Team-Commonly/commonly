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

  // The space form is the one a shell user types. It used to parse as an
  // unbounded run under --apply: the bound was never read, so the scan widened.
  it('reads the space form and keeps --apply after it', () => {
    const { apply, resolvedBefore } = parseArgs(['node', 'script', '--resolved-before', '2026-09-06', '--apply']);
    expect(apply).toBe(true);
    expect(resolvedBefore.toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });

  it.each([
    ['--resolved-before', '--apply'],
    ['--resolved-before'],
  ])('throws when the bound has no value: %s', (...argv) => {
    expect(() => parseArgs(['node', 'script', ...argv])).toThrow(/not a date/);
  });

  it.each([['--aplly'], ['--apply=yes'], ['--resolved_before=2026-09-06']])(
    'throws on an unknown or misspelled flag: %s',
    (flag) => {
      expect(() => parseArgs(['node', 'script', flag])).toThrow(/Unknown argument/);
    },
  );
});
