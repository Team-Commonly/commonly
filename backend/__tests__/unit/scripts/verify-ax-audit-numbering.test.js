// @ts-nocheck

const { checkAuditNumbering, DEFAULT_FILE } = require('../../../../scripts/verify-ax-audit-numbering');

const entry = (n, body = 'Body text.') => `## ${n}. Title ${n} (2026-01-01, seat)\n\n${body}\n`;

describe('verify-ax-audit-numbering', () => {
  it('passes a file whose entries are unique and each carry a body', () => {
    const text = `# Audit\n\n${entry(1)}\n${entry(3)}\n${entry(2)}`;
    expect(checkAuditNumbering(text)).toEqual({ entries: 3, problems: [] });
  });

  it('flags a duplicated number, naming both lines', () => {
    const text = `${entry(52)}\n${entry(52)}`;
    const { problems } = checkAuditNumbering(text);
    expect(problems).toContainEqual(expect.stringMatching(/entry 52 is defined twice \(lines 1 and 5\)/));
  });

  it('flags an empty entry stacked directly on the next heading', () => {
    const text = `## 52. Stub (2026-08-30, a)\n${entry(53)}`;
    const { problems } = checkAuditNumbering(text);
    expect(problems).toContainEqual(expect.stringMatching(/entry 52 .* has no body/));
  });

  it('does not require gap-free numbering', () => {
    const text = `${entry(38)}\n${entry(41)}`;
    expect(checkAuditNumbering(text).problems).toEqual([]);
  });

  it('keeps the committed audit file clean', () => {
    const fs = require('fs');
    const { problems } = checkAuditNumbering(fs.readFileSync(DEFAULT_FILE, 'utf8'));
    expect(problems).toEqual([]);
  });
});
