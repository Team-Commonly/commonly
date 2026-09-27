#!/usr/bin/env node
/**
 * Numbered-rule guard for `docs/development/review-checklist.md`.
 *
 * The rules in that file are numbered, and the numbers are cited BY NUMBER from
 * outside it — the file's own header names three (`ADR-028` rule 23, `ADR-019`
 * rule 9, `REVIEW.md` §7) and the rules cite each other nine more times
 * (`rule 5`, `rule 7`, `rule 9`, `rule 12` twice, `rule 14`, `rule 16`,
 * `rule 23`, `rules 27–28`). A number is therefore a name, and nothing in the
 * toolchain noticed when two PRs claimed one: on 2026-09-25 main gained a
 * `rule 34` (#1877) while an open PR added its own `rule 34`, which git caught
 * as a text conflict only because both appended at the file's end. An insert
 * mid-file conflicts less reliably, and a keep-both merge of two rule 34s
 * would have shipped silently — the same shape as the ADR-018 duplicate that
 * mis-routed a citation into a wake-policy regression.
 *
 * Checks:
 *   1. every rule's literal number is unique
 *   2. the numbers are 1..N, ascending, with no gap (the file's header states
 *      this; a gap is what a dropped rule leaves behind)
 *   3. every `rule N` / `rules N–M` citation inside the file resolves to a
 *      rule that exists, and a range ascends
 *   4. with `--previous <the version on main right now>`, no rule that exists in
 *      BOTH versions has changed its NUMBER OR ITS LEAD SENTENCE. Two numbers
 *      changed hands and nothing else says so:
 *        - MOVED: the rule at N is now at M. Every citation of N — the ones in
 *          ADR-028, ADR-019 and REVIEW.md, and the nine inside this file —
 *          silently points at different text. New rules go at the END of the
 *          file (the header's own instruction), so a move is always a defect.
 *        - CLAIMED TWICE: main defines rule N and this version defines a
 *          different rule at N. That is two PRs adding a rule against one
 *          number, each green on its own — the collision of 2026-09-25 — and
 *          it is why the reference file is main, not the merge base: a PR's
 *          merge base predates whatever landed while it was open, which is the
 *          only state this check exists to see.
 *
 * Deliberately NOT checked:
 *   - a rule that exists in `--previous` and NOT in this file. That is the
 *     ordinary state of a PR opened before another rule landed — on a PR it
 *     means "predates", not "deleted" — and it is not distinguishable from a
 *     tail deletion without more history. A rule deleted from the middle is
 *     caught anyway, by the gap in check 2.
 *   - an in-place edit of a rule's BODY. Only the bold lead sentence is
 *     compared, since that is the rule's name. Editing the lead itself is
 *     reported as a number claimed twice, because a rewritten lead and a
 *     foreign rule at the same number are the same bytes; keep leads stable.
 *   - citations from other files (`ADR-028` rule 23 and friends). Resolving
 *     those needs to know which `rule N` a document means, which is the
 *     ambiguity this guard exists to keep from growing; they are protected by
 *     the two checks above, which keep the numbers and the names stable.
 *
 * Withdrawing a rule, if the day comes: append the withdrawal to the rule's
 * BODY and leave its number, its lead sentence and its neighbours alone. That
 * is green, the number stays claimed, and a citation of it still resolves —
 * to a rule that says it is withdrawn. The two obvious routes both fail, and
 * the failures are measured rather than reasoned (cases m9-m11 in the
 * campaign): deleting the rule and closing the gap renumbers every rule after
 * it (14 errors on a 34-rule file, each one a citation now pointing at
 * different text), and marking the lead `Withdrawn` reads as a second rule
 * claiming that number (1 error). There is no bypass — deliberately, the same
 * as adr-numbering-guard.yml — so the body is where a retraction goes.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

// Resolved from the working directory, not from __dirname: the CI job loads
// this script from a temp dir (so that a PR branched before the guard landed
// still runs the checker from main — see the workflow), and __dirname there
// would point the file lookup at /tmp. The first run of this guard redded on
// exactly that: ENOENT /tmp/docs/development/review-checklist.md.
const ROOT = process.cwd();
const DEFAULT = path.join('docs', 'development', 'review-checklist.md');
const FILE = path.resolve(argValue('--file', DEFAULT));
const PREVIOUS = argValue('--previous', null);

// A rule begins with its literal number followed by a bold lead. Nothing else
// in the file currently looks like this (35 rules, 35 matches); a bold-lead
// list item nested inside a rule's body would be read as a rule, which is why
// the file keeps its numbered lists un-bolded.
const DEF = /^(\d+)\.\s+\*\*/;
// `rule 5`, `rules 27–28`, `rules 5, 7 and 9` — the separators are what a list
// of citations uses. Ranges accept hyphen, en dash and em dash.
const RANGE = '[\\u2010-\\u2015-]';
const CITE = new RegExp(
  `\\brules?\\s+(\\d+(?:\\s*${RANGE}\\s*\\d+)?(?:\\s*(?:,|and|&)\\s*\\d+(?:\\s*${RANGE}\\s*\\d+)?)*)`,
  'gi'
);

const fingerprint = (text) => text
  .replace(/\*\*/g, '')
  .replace(/[`*_]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 60);

/** Parse a rule file into [{number, line, lead, fingerprint}]. */
function parseRules(body) {
  const lines = body.split('\n');
  const rules = [];
  let current = null;
  lines.forEach((line, i) => {
    const m = DEF.exec(line);
    if (m) {
      current = { number: Number(m[1]), line: i + 1, lines: [line] };
      rules.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  });
  for (const r of rules) {
    // The bold lead, up to its closing `**`, is the rule's name.
    const joined = r.lines.join('\n');
    const lead = /\*\*(.+?)\*\*/s.exec(joined);
    r.lead = fingerprint(lead ? lead[1] : joined);
    delete r.lines;
  }
  return rules;
}

/** Every citation in the file's prose, as {number, text, line} per number. */
function parseCitations(body) {
  const found = [];
  const lines = body.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    CITE.lastIndex = 0;
    let m;
    while ((m = CITE.exec(line)) !== null) {
      const parts = m[1].split(/\s*(?:,|and|&)\s*/i).filter(Boolean);
      for (const part of parts) {
        const range = part.split(new RegExp(`\\s*${RANGE}\\s*`));
        if (range.length === 2) {
          found.push({ number: Number(range[0]), end: Number(range[1]), text: m[0], line: i + 1 });
        } else {
          found.push({ number: Number(range[0]), end: null, text: m[0], line: i + 1 });
        }
      }
    }
  });
  return found;
}

const errors = [];
// A path outside the repo (CI materialises the base version in a temp dir) is
// printed as given; a relative one is what a reader of the log can click.
const rel = path.relative(ROOT, FILE);
const file = rel.startsWith('..') ? FILE : rel;
const body = fs.readFileSync(FILE, 'utf8');
const rules = parseRules(body);

// 1. uniqueness
const byNumber = new Map();
for (const r of rules) {
  if (!byNumber.has(r.number)) byNumber.set(r.number, []);
  byNumber.get(r.number).push(r);
}
for (const [n, dupes] of [...byNumber].sort((a, b) => a[0] - b[0])) {
  if (dupes.length > 1) {
    errors.push(
      `rule ${n} is defined ${dupes.length} times (lines ${dupes.map((d) => d.line).join(', ')}). ` +
      `A duplicated number makes every citation of "rule ${n}" ambiguous — the two rules merge green ` +
      `when they arrive from different PRs. Keep one at ${n}, send the other to the end of the file.`
    );
  }
}

// 2. contiguity and order
rules.forEach((r, i) => {
  if (i === 0 && r.number !== 1) {
    errors.push(`the first rule is numbered ${r.number}; the file starts at 1.`);
  }
  if (i > 0) {
    const prev = rules[i - 1];
    if (r.number === prev.number) return; // already reported as a duplicate
    if (r.number === prev.number + 1) return;
    const gap = r.number - prev.number - 1;
    const missing = r.number > prev.number + 1
      ? `missing ${gap === 1 ? `${prev.number + 1}` : `${prev.number + 1}..${r.number - 1}`}`
      : 'none — this is a descent';
    errors.push(
      `line ${r.line}: rule ${r.number} follows rule ${prev.number} — the numbers must ascend 1..N with ` +
      `no gap (${missing}). ` +
      `A gap is what a deleted or renumbered rule leaves behind, and citations still point into it.`
    );
  }
});

// 3. citations resolve
const max = rules.length ? Math.max(...rules.map((r) => r.number)) : 0;
for (const c of parseCitations(body)) {
  const targets = c.end === null ? [c.number] : [c.number, c.end];
  if (c.end !== null && c.number >= c.end) {
    errors.push(`line ${c.line}: "${c.text}" is not an ascending range (${c.number} → ${c.end}).`);
  }
  for (const t of targets) {
    if (!byNumber.has(t)) {
      errors.push(
        `line ${c.line}: "${c.text}" cites rule ${t}, which does not exist (rules are 1..${max}). ` +
        `A citation into a gap resolves to the wrong rule or to nothing.`
      );
    }
  }
}

// 4. no rule moved, and no number is claimed by two different rules, against
//    the version on main right now
if (PREVIOUS) {
  if (!fs.existsSync(PREVIOUS)) {
    errors.push(`--previous ${PREVIOUS} does not exist; the stability check cannot run, so this guard will not pass.`);
  } else {
    const prevRules = parseRules(fs.readFileSync(PREVIOUS, 'utf8'));
    for (const p of prevRules) {
      const here = byNumber.get(p.number);
      // Absent here = this version predates that rule (or dropped a tail rule).
      // Not an error: on a PR against a moving main it is the normal state.
      if (!here || here.length !== 1) continue;
      if (here[0].lead === p.lead) continue; // same number, same name

      const moved = rules.find((r) => r.lead === p.lead);
      if (moved) {
        errors.push(
          `rule ${p.number} ("${p.lead}…") is now rule ${moved.number} (line ${moved.line}). ` +
          `Every citation of rule ${p.number} — including the ones in ADR-028, ADR-019 and REVIEW.md — ` +
          `now points at different text. New rules go at the END of the file; do not insert mid-file.`
        );
      } else {
        errors.push(
          `rule ${p.number} on main is "${p.lead}…" and this version's rule ${p.number} is ` +
          `"${here[0].lead}…" (line ${here[0].line}) — one number, two rules. This is what two PRs each ` +
          `adding a rule look like when they pick the same number: each is green alone, and the second ` +
          `one to merge silently re-points every citation of rule ${p.number}. Main is at ${prevRules.length} ` +
          `rules; renumber this one above that, or append it at the end.`
        );
      }
    }
  }
}

const cited = parseCitations(body).length;
if (errors.length) {
  for (const e of errors) console.error(`::error file=${file}::${e}`);
  console.error(`\n${errors.length} numbering problem(s) in ${file} (${rules.length} rules).`);
  process.exit(1);
}
console.log(
  `✓ ${file}: ${rules.length} rules, numbers 1..${max} ascending with no gap, ` +
  `${cited} citation(s) all resolve${PREVIOUS ? ', and no rule changed its number or its name' : ''}.`
);
