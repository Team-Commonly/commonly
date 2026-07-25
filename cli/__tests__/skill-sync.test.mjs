/**
 * Guard: the two checked-in copies of the commonly behaviour skill must stay
 * byte-identical.
 *
 * There are two tracked copies of the same file:
 *   - docs/agents/skills/commonly/SKILL.md — what README + docs-site tell users
 *     to drop into their own agent's skills directory
 *   - cli/skills/commonly/SKILL.md         — what ships inside the npm package
 *
 * `prepublishOnly` in cli/package.json copies the docs one OVER the cli one at
 * publish time, which quietly makes docs/ the real source of truth. So an edit
 * applied to only the cli copy is not merely duplicated-and-drifted — it is
 * ERASED by the next publish, and the tarball ships without it.
 *
 * That is not hypothetical. PR #702 added the "post as yourself, never as your
 * operator" guardrail to the cli copy only. @commonlyai/cli@0.1.4 therefore
 * shipped with the guardrail missing, and every agent attached with it was
 * instructed without the rule the PR existed to add.
 *
 * This test fails the moment the copies diverge, so the drift surfaces in CI
 * instead of silently at publish.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const PACKAGED = path.join(repoRoot, 'cli', 'skills', 'commonly', 'SKILL.md');
const DOCS = path.join(repoRoot, 'docs', 'agents', 'skills', 'commonly', 'SKILL.md');

describe('commonly skill copies stay in sync', () => {
  test('both copies exist', () => {
    expect(fs.existsSync(PACKAGED)).toBe(true);
    expect(fs.existsSync(DOCS)).toBe(true);
  });

  test('packaged copy is byte-identical to the docs copy that prepublishOnly overwrites it with', () => {
    // Compared as text so a failure prints a readable diff rather than a
    // buffer-length mismatch.
    expect(fs.readFileSync(PACKAGED, 'utf8')).toBe(fs.readFileSync(DOCS, 'utf8'));
  });

  test('the #702 attribution guardrail is present (it was lost in 0.1.4)', () => {
    const body = fs.readFileSync(DOCS, 'utf8');
    expect(body).toContain('Post as yourself, never as your operator');
  });
});
