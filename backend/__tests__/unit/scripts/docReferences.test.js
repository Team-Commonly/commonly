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
 * The scope is code — `scripts/`, `backend/`, `cli/`, `frontend/` — plus the
 * repo-root `CLAUDE.md`, not `docs/` prose. It is deliberately not a whole-repo
 * link checker: prose inside `docs/` is the docs room's inventory to keep, and
 * this suite has to stay green while that wash runs. A docs-like tail inside a
 * URL (`…/skills/servicenow-docs/SKILL.md`) is not a repo path, and the
 * boundary in DOC_REF is what excludes it.
 *
 * Widened the same day, on the class's own remainder: the first sweep scanned
 * code only and its boundary rejected a leading slash, so the two dead pointers
 * in `CLAUDE.md` — the file an agent reads first — were in the one place the
 * guard could not look, in the root-relative form (`/docs/…`) that section
 * writes everything else in. `AGENTS.md` is a symlink to `CLAUDE.md` (git mode
 * 120000), so scanning the target covers both without reporting each dead line
 * twice.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCANNED_DIRS = ['scripts', 'backend', 'cli', 'frontend'];
// Repo-root files an agent is told to follow, scanned as well as the dirs.
const SCANNED_ROOT_FILES = ['CLAUDE.md'];
const SCANNED_EXTENSIONS = new Set(['.sh', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// The boundary excludes a match that continues a longer token — `-docs/`,
// `/docs/`, `worddocs/` — so a URL tail is not read as a repo path.
const DOC_REF = /(?<![A-Za-z0-9_/.-])\/?docs\/[A-Za-z0-9_./-]+\.md/g;
// A floor, not the current count: high enough that a broken extractor fails
// loudly, low enough that retiring a few references does not trip it.
const MIN_EXPECTED_REFERENCES = 20;

// A root-relative reference (`/docs/….md`) is the repo path with a leading
// slash; strip it, or `path.join` is handed an absolute path and resolves the
// wrong file. The optional `/` in DOC_REF is what lets the boundary still
// reject a URL tail — `…/a/b/docs/….md` fails the lookbehind on either position.
const extractDocReferences = (text) => [...text.matchAll(DOC_REF)]
  .map((match) => match[0].replace(/^\//, ''));

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
  for (const relativePath of [...SCANNED_ROOT_FILES, ...trackedFiles()]) {
    // The root files are markdown on purpose — that is what the front door is —
    // so the code-extension filter is for the scanned dirs only.
    const isRootFile = SCANNED_ROOT_FILES.includes(relativePath);
    if (!isRootFile && !SCANNED_EXTENSIONS.has(path.extname(relativePath))) continue;
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
    // Root-relative, the form CLAUDE.md writes its pointers in — and the same
    // URL tail must stay excluded with a real path behind it. The fixture is
    // the front door's own line, so it names what that line names (the
    // architecture doc); it is also a real dependency, because this suite scans
    // itself and would report the fixture as a dead pointer. A fixture that
    // must exist is therefore coupled to the docs inventory — when the
    // inventory retired the shorter-named Discord design doc it stranded this
    // line, and nothing in the fixture's own purpose could have predicted that.
    expect(extractDocReferences(
      '- **Discord Integration**: `/docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md`',
    )).toEqual(['docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md']);
    expect(extractDocReferences(
      '  "sourceUrl": "https://example.test/org/repo/docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md"',
    )).toEqual([]);
  });

  it('covers the front-door file agents are told to follow', () => {
    expect(references.some((ref) => ref.file === 'CLAUDE.md')).toBe(true);
  });

  it('a root-relative pointer to a file that is not there would be reported (positive control)', () => {
    // Assembled, not written down: a dead literal in this file is scanned by
    // this guard too, and repeating one would make the guard flag its own test.
    const absent = ['docs/agents', 'no-such-anchor-fixture.md'].join('/');
    const docs = extractDocReferences(`see \`/${absent}\` for the shape`);
    expect(docs).toEqual([absent]);
    expect(docs.every((doc) => !fs.existsSync(path.join(REPO_ROOT, doc)))).toBe(true);
  });

  it('every referenced doc exists', () => {
    const missing = [...new Set(references
      .filter((ref) => !fs.existsSync(path.join(REPO_ROOT, ref.doc)))
      .map((ref) => `${ref.file} -> ${ref.doc}`))];
    expect(missing).toEqual([]);
  });
});
