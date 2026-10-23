// @ts-nocheck

const { checkAuditNumbering, DEFAULT_FILE } = require('../../../../scripts/verify-ax-audit-numbering');

const entry = (n, body = 'Body text.') => `## ${n}. Title ${n} (2026-01-01, seat)\n\n${body}\n`;
const DOCUMENTED = new Set([39, 40, 44, 45, 46]);
const sequence = (from, to) => {
  const out = [];
  for (let n = from; n <= to; n += 1) if (!DOCUMENTED.has(n)) out.push(entry(n));
  return out.join('\n');
};

describe('verify-ax-audit-numbering', () => {
  it('passes a file whose entries are unique and each carry a body', () => {
    const text = `# Audit\n\n${entry(1)}\n${entry(3)}\n${entry(2)}`;
    expect(checkAuditNumbering(text)).toEqual({ entries: 3, problems: [] });
  });

  it('flags a duplicated number, naming both lines', () => {
    const text = `${entry(52)}\n${entry(52)}`;
    const { problems } = checkAuditNumbering(text);
    expect(problems).toContainEqual(expect.stringMatching(/entry 52 is defined twice/));
  });

  it('flags an empty entry stacked directly on the next heading', () => {
    const text = `## 52. Stub (2026-08-30, a)\n${entry(53)}`;
    const { problems } = checkAuditNumbering(text);
    expect(problems).toContainEqual(expect.stringMatching(/entry 52 .* has no body/));
  });

  it('allows the documented gaps (39, 40, 44-46)', () => {
    expect(checkAuditNumbering(sequence(1, 80)).problems).toEqual([]);
  });

  it('flags a number skipped in the sequence that is not a documented gap', () => {
    const text = `${sequence(1, 80)}\n${entry(82)}`;
    const { problems } = checkAuditNumbering(text);
    expect(problems).toEqual(['entry 81 is missing and is not a documented gap (highest entry is 82)']);
  });

  it('allows a descending run, since order is not checked', () => {
    const text = `${entry(3)}\n${entry(1)}\n${entry(2)}`;
    expect(checkAuditNumbering(text).problems).toEqual([]);
  });

  it('keeps the committed audit file clean', () => {
    const fs = require('fs');
    const { problems } = checkAuditNumbering(fs.readFileSync(DEFAULT_FILE, 'utf8'));
    expect(problems).toEqual([]);
  });
});
