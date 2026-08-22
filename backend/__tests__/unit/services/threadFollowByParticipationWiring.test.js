/**
 * Keep the comment and the code-base agreeing about followByParticipation.
 *
 * @sprint-review's third blocker on 3/4 (57306): threadWakeScopeService's
 * header asserted "the mention writes the row at the moment it happens, via
 * ThreadUserState.followByParticipation" — and nothing called it. The method
 * shipped, its tests passed, and the only thing claiming it was wired was
 * prose.
 *
 * The comment is corrected. This exists so it cannot drift back, in EITHER
 * direction: it fails if a production caller appears while the comment still
 * says there is none, and it fails if the comment stops saying so while there
 * is still no caller. A doc-vs-reality gap that only a reader can detect is
 * the failure mode being guarded, so the guard has to be executable.
 */

const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '../../..');
const SCOPE_SERVICE = path.join(BACKEND, 'services/threadWakeScopeService.ts');

/** Production source only: no tests, no node_modules, and not the model that defines it. */
const productionCallers = () => {
  const hits = [];
  const skipDir = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDir.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // The model DEFINES it; the scope service only mentions it in prose.
      if (full.endsWith('models/pg/ThreadUserState.ts')) continue;
      if (full === SCOPE_SERVICE) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (src.includes('followByParticipation')) hits.push(path.relative(BACKEND, full));
    }
  };
  walk(BACKEND);
  return hits;
};

describe('followByParticipation: the comment and the call graph agree', () => {
  const header = fs.readFileSync(SCOPE_SERVICE, 'utf8');
  const claimsUnwired = header.includes('NOTHING CALLS IT');

  test('the header still names the gap explicitly', () => {
    // If someone softens this to "may not be wired" the next reader cannot
    // tell whether it was checked. The assertion is on the loud phrasing.
    expect(claimsUnwired).toBe(true);
  });

  test('and the call graph matches what the header claims', () => {
    const callers = productionCallers();
    if (claimsUnwired) {
      expect(callers).toEqual([]);
    } else {
      // Comment says it IS wired — then something had better call it.
      expect(callers.length).toBeGreaterThan(0);
    }
  });
});
