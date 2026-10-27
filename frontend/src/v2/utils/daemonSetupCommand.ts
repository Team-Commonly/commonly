import getApiBaseUrl from '../../utils/apiBaseUrl';

// One-time computer setup (ADR-026 D1). `--instance` is explicit: a bare
// `commonly login` falls back to the CLI's built-in production default, so a
// dev or self-hosted page would register its computer against commonly.me.
// Connect builds its login line the same way (V2ConnectPage).
export const daemonSetupCommand = (apiUrl: string = getApiBaseUrl()): string =>
  `npm i -g @commonlyai/cli@latest && commonly login --instance ${apiUrl.replace(/\/+$/, '')} && commonly daemon register && commonly daemon install`;
