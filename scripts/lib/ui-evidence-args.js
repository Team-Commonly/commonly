/**
 * Argument parsing for `scripts/ui-evidence-shot.mjs`.
 *
 * Split out of the harness so the argument contract has a witness that needs no
 * browser: this module imports nothing, so a unit test can call it directly while
 * the script itself pulls Playwright in.
 *
 * Both refusals here exist because the harness once did the silent thing instead:
 *
 * - a flag the script did not implement was dropped, so `--width 390` produced a
 *   1440x900 capture under a `-390` name and the reviewer had no way to tell
 *   (2026-09-19, review-checklist rule 27);
 * - a value that belonged to nothing was skipped without a word, so
 *   `--width 390 400` ran with 390 and never mentioned the 400, and a route
 *   passed positionally (`node script /v2/pods/team/x --out a.png`) was ignored
 *   as if `--route` had been given. A typo'd flag is the other bucket:
 *   `--widht 390` is an unknown flag, not a stray value.
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      stray.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) {
      values.set(key, inline);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      values.set(key, argv[i + 1]);
      i += 1;
    } else {
      values.set(key, 'true');
    }
  }
  return { values, stray };
};

const refusalFor = ({ values, stray }) => {
  const lines = [];
  const unknown = [...values.keys()].filter((key) => !KNOWN_FLAGS.has(key));
  if (unknown.length > 0) lines.push(`unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}`);
  if (stray.length > 0) {
    lines.push(`unexpected value(s): ${stray.join(', ')} — a flag's value must follow its flag (--width 390) or be joined with '=' (--width=390)`);
  }
  if (lines.length === 0) return null;
  lines.push(`known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(', ')}`);
  return lines.join('\n');
};

module.exports = { KNOWN_FLAGS, parseArgs, refusalFor };
