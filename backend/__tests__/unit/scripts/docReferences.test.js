/**
 * Every `docs/<path>.md` a line of CODE mentions must exist.
 *
 * Earned 2026-09-20. The "Documentation:" block printed by
 * `scripts/test-discord.sh`, the recording-guide line in `scripts/setup-demo.sh`
 * and the setup-guide line in `backend/test-discord-integration.ts` all pointed
 * at docs that are not in the tree — the Discord ones live under `docs/discord/`.
 * A pointer to a file that is not there is AX entry 57's failure mode: the
 * operator follows the message their own tool just printed and finds nothing.
 *
 * The dead literals are not repeated here on purpose: a comment is scanned by
 * this guard too, so writing them down would make the guard flag its own
 * explanation. They are in the PR body and on the row.
 *
 * The scope is code — `scripts/`, `backend/`, `cli/`, `frontend/` — not docs.
 * This is deliberately not a whole-repo link checker: prose inside `docs/` is
 * the docs room's inventory to keep, and this suite has to stay green while
 * that wash runs. A docs-like tail inside a URL
 * (`…/skills/servicenow-docs/SKILL.md`) is not a repo path, and the boundary in
 * DOC_REF is what excludes it.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCANNED_DIRS = ['scripts', 'backend', 'cli', 'frontend'];
const SCANNED_EXTENSIONS = new Set(['.sh', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// The boundary excludes a match that continues a longer token — `-docs/`,
// `/docs/`, `worddocs/` — so a URL tail is not read as a repo path.
const DOC_REF = /(?<![A-Za-z0-9_/.-])docs\/[A-Za-z0-9_./-]+\.md/g;
// A floor, not the current count: high enough that a broken extractor fails
// loudly, low enough that retiring a few references does not trip it.
const MIN_EXPECTED_REFERENCES = 20;

const extractDocReferences = (text) => [...text.matchAll(DOC_REF)].map((match) => match[0]);

const trackedFiles = () => {
  try {
    return execFileSync('git', ['ls-files', ...SCANNED_DIRS], { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    throw new Error(
      `could not list tracked files with git from ${REPO_ROOT}: ${err.message}. `
      + 'This guard reads the checkout, so it needs a git work tree — run it from the repository '
      + '(and run `git status` by hand if this fires in CI).',
    );
  }
};

const collectReferences = () => {
  const references = [];
  for (const relativePath of trackedFiles()) {
    if (!SCANNED_EXTENSIONS.has(path.extname(relativePath))) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    for (const doc of extractDocReferences(text)) {
      references.push({ file: relativePath, doc });
    }
  }
  return references;
};

describe('code does not point at docs that are not there', () => {
  const references = collectReferences();

  it('extracts references at all — a parser that finds nothing passes every test below', () => {
    expect(references.length).toBeGreaterThanOrEqual(MIN_EXPECTED_REFERENCES);
    expect(references.some((ref) => ref.file.endsWith('.sh'))).toBe(true);
    expect(references.some((ref) => ref.file.startsWith('backend/'))).toBe(true);
  });

  it('reads a real path and not a docs-like tail inside a URL', () => {
    expect(extractDocReferences(
      '      "sourceUrl": "https://github.com/openclaw/skills/tree/main/skills/thesethrose/servicenow-docs/SKILL.md"',
    )).toEqual([]);
    expect(extractDocReferences(
      'echo "   Setup Guide: docs/discord/DISCORD_SETUP.md"',
    )).toEqual(['docs/discord/DISCORD_SETUP.md']);
  });

  it('every referenced doc exists', () => {
    const missing = [...new Set(references
      .filter((ref) => !fs.existsSync(path.join(REPO_ROOT, ref.doc)))
      .map((ref) => `${ref.file} -> ${ref.doc}`))];
    expect(missing).toEqual([]);
  });
});
