/**
 * Argument parsing for `scripts/ui-evidence-shot.mjs`.
 *
 * Split out of the harness so the argument contract has a witness that needs no
 * browser: this module imports nothing, so a unit test can call it directly while
 * the script itself pulls Playwright in.
 *
 * Four refusals here exist because the harness once did the silent thing instead:
 *
 * - a flag the script did not implement was dropped, so `--width 390` produced a
 *   1440x900 capture under a `-390` name and the reviewer had no way to tell
 *   (2026-09-19, review-checklist rule 27);
 * - a value that belonged to nothing was skipped without a word, so
 *   `--width 390 400` ran with 390 and never mentioned the 400, and a route
 *   passed positionally (`node script /v2/pods/team/x --out a.png`) was ignored
 *   as if `--route` had been given. A typo'd flag is the other bucket:
 *   `--widht 390` is an unknown flag, not a stray value;
 * - a value containing `=` was cut at the SECOND one, so
 *   `--route=/v2/x?a=1&b=2` ran as `/v2/x?a` and captured a different page under
 *   the right name;
 * - a repeated flag kept only its last value, and a flag given nothing (`--selector=`,
 *   the shape an unset shell variable takes) was treated as absent - the capture
 *   then scoped nothing or fell back to a default, and said so to no one;
 * - a flag followed by nothing at all was REPLACED by the string `true`
 *   (`--route $UNSET`), which is the same mistake with a worse ending: every other
 *   path here drops or truncates a value, this one invented one, and the capture
 *   went to a route literally named `true` under a file name that named the
 *   intended page (TASK-081, Vera 70182).
 *
 * `refusalFor` returns the whole message, or null. The caller prints it and exits 2.
 */
'use strict';

const KNOWN_FLAGS = new Set([
  'route', 'out', 'base-url', 'api', 'email', 'password', 'wait', 'selector', 'width', 'height',
  'token', 'click',
]);

const parseArgs = (argv) => {
  const values = new Map();
  const stray = [];
  const repeated = [];
  const empty = [];
  const bare = [];
  const take = (key, value) => {
    if (values.has(key)) repeated.push(key);
    values.set(key, value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      stray.push(arg);
      continue;
    }
    // Split at the FIRST '=' only: a value is allowed to contain one, and
    // `--route=/v2/x?a=1&b=2` is a route, not a route plus a stray `b=2`.
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      const key = raw.slice(0, eq);
      const inline = raw.slice(eq + 1);
      if (inline === '') {
        // Recorded in `values` as well, so an unknown flag given an empty value
        // (`--widht=`) is reported as unknown AND empty rather than only empty.
        empty.push(key);
        take(key, '');
      } else take(key, inline);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      take(raw, argv[i + 1]);
      i += 1;
    } else {
      // No value follows. Every flag this harness implements takes one, so a bare
      // flag is an unset variable or a forgotten argument - never a switch. It is
      // still recorded in `values`, so an unknown bare flag is reported as unknown
      // AND bare rather than only bare.
      bare.push(raw);
      take(raw, 'true');
    }
  }
  return {
    values, stray, repeated, empty, bare,
  };
};

const refusalFor = ({
  values, stray, repeated = [], empty = [], bare = [],
}) => {
  const lines = [];
  const unknown = [...values.keys()].filter((key) => !KNOWN_FLAGS.has(key));
  if (unknown.length > 0) lines.push(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}`);
  if (stray.length > 0) {
    lines.push(`unexpected value(s): ${stray.join(', ')} — a flag's value must follow its flag (--width 390) or be joined with '=' (--width=390)`);
  }
  if (repeated.length > 0) {
    lines.push(`repeated flag(s): ${repeated.map((f) => `--${f}`).join(', ')} — the first value was already accepted, and only one of them can be the one you meant`);
  }
  if (empty.length > 0) {
    lines.push(`empty value(s): ${empty.map((f) => `--${f}=`).join(', ')} — an empty value is not the same as a missing flag, and is usually an unset variable`);
  }
  if (bare.length > 0) {
    lines.push(`flag(s) with no value: ${bare.map((f) => `--${f}`).join(', ')} — every flag here takes a value, so a flag followed by nothing (or by the next flag) is an unset variable or a forgotten argument, not a switch. There is no boolean flag to pass bare.`);
  }
  if (lines.length === 0) return null;
  lines.push(`known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(', ')}`);
  return lines.join('\n');
};

module.exports = {
  KNOWN_FLAGS, parseArgs, refusalFor,
};
