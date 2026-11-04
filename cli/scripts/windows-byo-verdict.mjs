/**
 * D164: what the Windows Bring-your-own walk fails on. Pure, so it is tested
 * off Windows (cli/__tests__/windows-byo-verdict.test.mjs); the walk itself is
 * windows-byo-smoke.mjs.
 */

// Pasted right after the install line. PowerShell runs the next line whatever
// a native command exits with, so without this a failed install goes on to
// run whichever `commonly` is already on PATH: in this tree's leg, the
// published CLI the first leg installed, which would pass for this checkout.
// `$LASTEXITCODE`, not `$?`: Windows PowerShell can clear `$?` when npm only
// warns on stderr. A missing `npm` leaves it unset, and `commonly` then never
// polls, which fails the leg anyway.
export const INSTALL_GUARD = 'if ($LASTEXITCODE) { Write-Output "windows-byo-smoke: the install line exited $LASTEXITCODE"; exit 97 }';

/** The page's lines as pasted: the install line, the guard, the rest. */
export const pasteScript = (lines) => [lines[0], INSTALL_GUARD, ...lines.slice(1)];

/** The install line's exit code when the guard tripped, else null. */
export const installExitFrom = (out) => {
  const m = /windows-byo-smoke: the install line exited (-?\d+)/.exec(String(out || ''));
  return m ? Number(m[1]) : null;
};

/**
 * Which of a leg's problems fail the check and which are only reported.
 *
 * `reportOnly` is the published leg on a pull request. A CLI fix reaches npm
 * only after it merges, so what the published CLI does once it holds an
 * @mention is reported there and this tree's leg decides. That leg replaces
 * the page's install line, though, so it cannot stand in for it: a published
 * install that fails, or a published CLI that never picks up its @mention,
 * fails the pull request too.
 *
 * @returns {{ fail: string[], warn: string[] }}
 */
export const publishedOutcome = ({ problems = [], installExit = null, delivered = false } = {}, { reportOnly = false } = {}) => {
  const all = installExit === null
    ? [...problems]
    : [`the install line exited ${installExit}`, ...problems];
  if (!all.length) return { fail: [], warn: [] };
  if (reportOnly && installExit === null && delivered) return { fail: [], warn: all };
  return { fail: all, warn: [] };
};
