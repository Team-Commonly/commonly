#!/usr/bin/env node
/**
 * Entry-number guard for `docs/development/agent-experience-audit.md`.
 *
 * Each entry is a `## N. <title>` heading, and the numbers are cited from
 * other docs and from memory (`AX audit entries 34 and 35`, `entry 22`). A
 * number is therefore a name. Nothing checked it, and the file reached two
 * entries numbered 52 — one of them an empty heading sitting directly on top
 * of entry 53 with the same title. Citing "52" then pointed at whichever
 * copy a reader found first.
 *
 * Checks:
 *   1. every `## N.` entry heading has a unique number
 *   2. no heading sits with no body before the next heading (an empty stub is
 *      how a duplicate hides in plain sight)
 *
 * Deliberately NOT checked: density. The file is not dense (entries 39-40 and
 * 44-46 are absent) and entries are appended in whatever order they were
 * written, so neither a gap nor a descending run is a defect here.
 *
 * Usage: node scripts/verify-ax-audit-numbering.js [path]
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'docs', 'development', 'agent-experience-audit.md');
const HEADING = /^## (\d+)\. /;

function checkAuditNumbering(text) {
  const problems = [];
  const lines = text.split('\n');
  const seen = new Map();
  const headings = [];

  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (m) headings.push({ number: m[1], line: i + 1 });
  });

  headings.forEach(({ number, line }, idx) => {
    if (seen.has(number)) {
      problems.push(`entry ${number} is defined twice (lines ${seen.get(number)} and ${line})`);
    } else {
      seen.set(number, line);
    }

    const next = headings[idx + 1];
    const end = next ? next.line - 1 : lines.length;
    const bodyLines = lines.slice(line, end).filter((l) => l.trim() !== '');
    if (bodyLines.length === 0) {
      problems.push(`entry ${number} (line ${line}) has no body before the next heading`);
    }
  });

  return { entries: headings.length, problems };
}

function main(argv) {
  const file = argv[2] || DEFAULT_FILE;
  const { entries, problems } = checkAuditNumbering(fs.readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error(`AX audit numbering: ${problems.length} problem(s) in ${file}`);
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exit(1);
  }
  console.log(`AX audit numbering OK: ${entries} entries, every number unique and every entry has a body.`);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { checkAuditNumbering, DEFAULT_FILE };
