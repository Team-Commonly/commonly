// One escapeRegExp and one escapeHtml for the backend. Ten modules used to
// carry their own copies; these pin the behaviour they all had.
const { escapeRegExp, escapeHtml } = require('../../../utils/escape');

describe('escapeRegExp', () => {
  it('makes every RegExp metacharacter match itself', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw)).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
  });

  it('reads null and undefined as empty, and coerces other values', () => {
    expect(escapeRegExp(undefined)).toBe('');
    expect(escapeRegExp(null)).toBe('');
    expect(escapeRegExp(1.5)).toBe('1\\.5');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in content and quoted attributes', () => {
    expect(escapeHtml('<a href="x" title=\'y\'>&</a>'))
      .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('reads null and undefined as empty', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
  });
});
