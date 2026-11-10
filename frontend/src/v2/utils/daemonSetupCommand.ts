import getApiBaseUrl from '../../utils/apiBaseUrl';

// One-time computer setup (ADR-026 D1, F370). One line, run through npx so there
// is nothing to install first: `daemon setup` installs the CLI UNDER $HOME (no
// global install, no sudo — the stock-Node Mac `npm i -g` EACCES that cost a
// first-timer an hour), then logs in, registers this computer, and starts the
// daemon. `--instance` is explicit: a bare `commonly login` falls back to the
// CLI's built-in production default, so a dev or self-hosted page would
// otherwise register its computer against commonly.me. Connect builds its line
// the same way (V2ConnectPage). On Windows the page appends `--unsandboxed`,
// forwarded to the install step (agents run without a sandbox there, as
// `agent run` does).
export const daemonSetupCommand = (apiUrl: string = getApiBaseUrl()): string =>
  `npx -y @commonlyai/cli@latest daemon setup --instance ${apiUrl.replace(/\/+$/, '')}`;
