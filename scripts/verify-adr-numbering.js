#!/usr/bin/env node
/**
 * ADR numbering guard.
 *
 * An ADR number is a name two documents can claim at once, and nothing in the
 * toolchain notices. #1295 and #1268 both added `docs/adr/ADR-025-*.md` under
 * different slugs: no textual conflict, `merge-tree` clean, every check green,
 * and main carried two ADR-025s the moment the second one merged. The same
 * thing had already happened at ADR-018 (`agent-attention-claims` and
 * `agent-identity`), where the duplicate survived long enough that a PR author
 * followed the wrong one and shipped a wake-policy regression (#963).
 *
 * Both were caught by a human reading a directory listing. This makes the
 * third one go red.
 *
 * Checks, against the working tree:
 *   1. every file in docs/adr/ is named ADR-NNN-slug.md
 *   2. no two files claim the same NNN
 *   3. the H1 title's number matches the filename's number
 *
 * Deliberately NOT checked: contiguity. main is missing 029 and that is fine —
 * a gap costs nothing, and requiring density would make every renumber a
 * cascade.
 */
const fs = require('fs');
const path = require('path');

// `--dir` lets CI point this at a materialised "what main would look like
// after this merges" tree, rather than at the checkout. See
// .github/workflows/adr-numbering-guard.yml for why the merge ref is not that.
const dirArg = process.argv.indexOf('--dir');
const DIR = dirArg !== -1 && process.argv[dirArg + 1]
  ? path.resolve(process.argv[dirArg + 1])
  : path.join(__dirname, '..', 'docs', 'adr');
const FILENAME = /^ADR-(\d{3})-[a-z0-9-]+\.md$/;
// Titles use both "ADR-018 — x" and "ADR-018: x". Match the number only.
const H1 = /^#\s+ADR-(\d{3})\b/m;

const errors = [];
const byNumber = new Map();

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();

for (const file of files) {
  const m = FILENAME.exec(file);
  if (!m) {
    errors.push(`${file}: not named ADR-NNN-slug.md (three digits, lowercase hyphenated slug).`);
    continue;
  }
  const num = m[1];
  if (!byNumber.has(num)) byNumber.set(num, []);
  byNumber.get(num).push(file);

  const body = fs.readFileSync(path.join(DIR, file), 'utf8');
  const h1 = H1.exec(body);
  if (!h1) {
    errors.push(`${file}: no H1 of the form "# ADR-${num} — Title".`);
  } else if (h1[1] !== num) {
    errors.push(
      `${file}: filename says ADR-${num}, H1 says ADR-${h1[1]}. A renamed file whose title still ` +
      `carries the old number is cited by BOTH numbers and found by neither.`
    );
  }
}

for (const [num, dupes] of [...byNumber].sort()) {
  if (dupes.length > 1) {
    errors.push(
      `ADR-${num} is claimed by ${dupes.length} files: ${dupes.join(', ')}. ` +
      `Two documents under one number make every citation of it ambiguous — renumber all but one.`
    );
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error file=docs/adr::${e}`);
  console.error(`\n${errors.length} ADR numbering problem(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`✓ ${files.length} ADRs, ${byNumber.size} distinct numbers, no collisions, every H1 agrees with its filename.`);
