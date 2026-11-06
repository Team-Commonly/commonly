// F154: the F104 canary checks that Claude Code's permission layer refused a
// Read. Claude Code words that refusal more than one way (a file rule and a
// directory rule print different text), so the check keys on "refused, and
// nothing leaked", not on one sentence. A leak fails whatever the wording.
import { describe, expect, test } from '@jest/globals';
import { classifyReadRefusal } from '../scripts/security/deny-rule-refusal.mjs';

const SECRET = 'git-config-canary-c104';
const FILE = '/tmp/claude-x/work/.git/f104-canary';

describe('classifyReadRefusal', () => {
  test('the file-rule wording is a refusal', () => {
    const text = `<tool_use_error>Permission to read ${FILE} has been denied.</tool_use_error>`;
    expect(classifyReadRefusal({ text, isError: true, secret: SECRET }).verdict).toBe('refused');
  });

  test('the directory-rule wording is a refusal', () => {
    const text = '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>';
    expect(classifyReadRefusal({ text, isError: true, secret: SECRET }).verdict).toBe('refused');
  });

  test('a file-rule refusal for a path with spaces is still a refusal', () => {
    const text = '<tool_use_error>Permission to read /tmp/my project/.git/f104-canary has been denied.</tool_use_error>';
    expect(classifyReadRefusal({ text, isError: true, secret: SECRET }).verdict).toBe('refused');
  });

  test('a negated or partial permission sentence is not a refusal', () => {
    for (const text of [
      'File was not denied by your permission settings.',
      'This is not denied by your permission settings.',
      'Permission to read has been denied',
    ]) {
      expect(classifyReadRefusal({ text, isError: true, secret: SECRET }).verdict).toBe('inconclusive');
    }
  });

  test('output carrying the canary marker is a leak, even when it also says denied', () => {
    const text = `Permission to read ${FILE} has been denied.\n     1→${SECRET}`;
    expect(classifyReadRefusal({ text, isError: true, secret: SECRET }).verdict).toBe('leaked');
    const dirWording = `File is in a directory that is denied by your permission settings. ${SECRET}`;
    expect(classifyReadRefusal({ text: dirWording, isError: true, secret: SECRET }).verdict).toBe('leaked');
  });

  test('a tool result that is not an error is a read, not a refusal', () => {
    const text = 'File is in a directory that is denied by your permission settings.';
    expect(classifyReadRefusal({ text, isError: false, secret: SECRET }).verdict).toBe('read');
  });

  test('output with neither a deny nor a leak is inconclusive', () => {
    expect(classifyReadRefusal({ text: 'Something went wrong.', isError: true, secret: SECRET }).verdict)
      .toBe('inconclusive');
    // "denied" on its own, outside a permission-layer sentence, is not a refusal.
    expect(classifyReadRefusal({ text: 'Request denied.', isError: true, secret: SECRET }).verdict)
      .toBe('inconclusive');
  });

  test('an OS error is the filesystem refusing, not the deny rule', () => {
    for (const text of [
      `EACCES: permission denied, open '${FILE}'`,
      `ENOENT: no such file or directory, open '${FILE}'`,
      'File does not exist.',
    ]) {
      expect(classifyReadRefusal({ text, isError: true, secret: SECRET }).verdict).toBe('filesystem');
    }
  });

  test('a secret is required, so a leak check can never be skipped by omission', () => {
    expect(() => classifyReadRefusal({ text: 'x', isError: true })).toThrow(/secret/);
  });
});
