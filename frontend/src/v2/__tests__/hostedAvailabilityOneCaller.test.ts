import fs from 'fs';
import path from 'path';

// GET /api/hosted/availability also records User.onboarding.byoOpenedAt, the
// first time a person opens the Bring your own page (backend/routes/hosted.ts,
// services/onboardingMarks.ts). That reading is only true while the page is the
// endpoint's one caller in the app. A second caller (a badge, a prefetch, a
// dashboard tile) would mark people who never opened the page, and the setup
// funnel would inflate without any error. Adding a caller means moving the mark
// to a signal of its own first.
//
// Scope is the shipped app. scripts/smoke-stranger-path.mjs also calls the
// endpoint, as a test account that every outside count already excludes.

const SRC = path.join(__dirname, '..', '..');

const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['__tests__', '__mocks__', 'node_modules'].includes(entry.name) ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [full] : [];
  });

describe('GET /api/hosted/availability', () => {
  test('has exactly one caller, the Bring your own page, so byoOpenedAt means "opened Bring your own"', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('hosted/availability'))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(callers).toEqual(['v2/components/V2AgentBYO.tsx']);
  });
});
