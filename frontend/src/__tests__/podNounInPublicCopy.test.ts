// @ts-nocheck
// The product noun is "pod" (Sam kept it 09-06), in outside copy too. Earned
// 2026-11-14: the site-wide footer link for the Pod Browser use case read
// "Find the right room before entering chat", on every public page. This pins
// the use-case labels and titles, which feed that footer and the page heads.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const useCases = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/src/content/use-cases.json'), 'utf8'));

describe('public use-case copy says pod, never room', () => {
  test.each(Object.entries(useCases))('%s: link label, title and title tag', (_, entry) => {
    ['linkLabel', 'title', 'titleTag'].forEach((field) => {
      if (typeof entry[field] !== 'string') return;
      expect(entry[field]).not.toMatch(/\brooms?\b/i);
    });
  });
});
