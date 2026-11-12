import getApiBaseUrl from '../../utils/apiBaseUrl';

// One-time computer setup (ADR-026 D1, F370). One line, run through npx so there
// is nothing to install first: `daemon setup` installs the CLI UNDER $HOME (no
// global install, no sudo — the stock-Node Mac `npm i -g` EACCES that cost a
// first-timer an hour), then logs in, registers this computer, and starts the
// daemon. `--instance` is explicit: a bare `commonly login` falls back to the
// CLI's built-in production default, so a dev or self-hosted page would
// otherwise register its computer against commonly.me. Connect builds its line
// the same way (V2ConnectPage).
export const daemonSetupCommand = (apiUrl: string = getApiBaseUrl()): string =>
  `npx -y @commonlyai/cli@latest daemon setup --instance ${apiUrl.replace(/\/+$/, '')}`;

export type DaemonSetupOs = 'unix' | 'windows';

// The line for the computer being set up. On Windows it names npx.cmd:
// PowerShell runs the .ps1 shim for a bare `npx`, and Windows 11's default
// script policy refuses it (F342). It also carries `--unsandboxed`, forwarded to
// the install step: agents run without a sandbox there, as `agent run` does.
// Every surface that shows the line takes it from here (F467), and CI runs this
// exact text on Windows and macOS (cli/scripts/daemon-setup-line-smoke.mjs).
export const daemonSetupCommandFor = (os: DaemonSetupOs, apiUrl: string = getApiBaseUrl()): string => (
  os === 'windows'
    ? `${daemonSetupCommand(apiUrl).replace(/^npx /, 'npx.cmd ')} --unsandboxed`
    : daemonSetupCommand(apiUrl)
);

// navigator.platform reads "Win32" on every Windows browser, 64-bit included.
// Browser spellings only, case-sensitive: jsdom's user agent carries the host's
// process.platform in lower case, which must not flip a page on a CI host.
export const browserIsWindows = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.userAgent || '';
  return /Windows/.test(platform) || /^Win/.test(nav.platform || '');
};
