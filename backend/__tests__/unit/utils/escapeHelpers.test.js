// @ts-nocheck
// Shared escape helpers: one copy per runtime (TASK-006). Null/undefined must
// render as '' in HTML, never the literal "null".

const { escapeHtml } = require('../../../utils/escapeHtml');
const { escapeRegExp } = require('../../../utils/escapeRegExp');

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  });

  it('renders null and undefined as an empty string, not "null"', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stringifies non-null values', () => {
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('escapeRegExp', () => {
  it('makes every regex metacharacter literal', () => {
    const source = '.*+?^${}()|[]\\';
    expect(new RegExp(escapeRegExp(source)).test(source)).toBe(true);
    expect(new RegExp(escapeRegExp('a.c')).test('abc')).toBe(false);
  });
});
