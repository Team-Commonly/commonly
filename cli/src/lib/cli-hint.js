// The commands this CLI prints for a person to type (F435).
//
// npm installs `commonly` and `npx` on Windows as three shims: a `.ps1`, a
// `.cmd` and a bare sh script. PowerShell picks the `.ps1` first, and its
// default execution policy (Restricted on a Windows client) refuses to run
// it, so a printed `commonly daemon install` fails there before it starts.
// The `.cmd` shim is not a script to PowerShell and runs under any policy, and
// it runs the same in cmd.exe. So on win32 every hint names `commonly.cmd`,
// `npx.cmd` or `npm.cmd`; elsewhere the bare name.
//
// Windows PowerShell 5.1 has no `&&`, and `;` would run the second step even
// when the first failed, so steps that depend on each other print one per line
// on win32 (`cliSteps`).
//
// The guard in __tests__/cli-hint.test.mjs fails on a `commonly <subcommand>`
// written into a string anywhere else in cli/src: use `${CLI} <subcommand>`.

export const cliName = (platform = process.platform) => (platform === 'win32' ? 'commonly.cmd' : 'commonly');
export const npxName = (platform = process.platform) => (platform === 'win32' ? 'npx.cmd' : 'npx');
export const npmName = (platform = process.platform) => (platform === 'win32' ? 'npm.cmd' : 'npm');

export const CLI = cliName();
export const NPX = npxName();
export const NPM = npmName();

// Commands that run one after another, each only if the one before succeeded.
// Joined with ` && ` on POSIX shells; on win32, one command per line, each
// indented by `indent`, so the reader runs them in order.
export const cliSteps = (steps, { platform = process.platform, indent = '  ' } = {}) => (
  platform === 'win32'
    ? steps.map((step) => `\n${indent}${step}`).join('')
    : steps.join(' && ')
);
