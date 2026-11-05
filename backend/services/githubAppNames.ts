/**
 * The two GitHub Apps the backend signs for (F172), kept apart from
 * githubAppService so that the broker can read a row's App and the instance's
 * configuration without the HTTP client (which many suites mock whole).
 *
 *  - `tools`: the private commonly-tools App (`GITHUB_APP_ID` /
 *    `GITHUB_APP_PRIVATE_KEY`). It is installed on our own org only, and every
 *    `github-app` row written before F172 belongs to it.
 *  - `connect`: the public Commonly Connect App (`GITHUB_CONNECT_APP_ID` /
 *    `GITHUB_CONNECT_APP_PRIVATE_KEY`). Outside teams install it.
 *
 * An installation id is signed only by the App it belongs to. A Connect
 * installation is never signed with the tools key, and a missing Connect key
 * refuses rather than falling back.
 */
export type GitHubAppName = 'tools' | 'connect';

export const GITHUB_APP_NAMES: ReadonlyArray<GitHubAppName> = ['tools', 'connect'];

const APP_ENV: Record<GitHubAppName, { id: string; key: string }> = {
  tools: { id: 'GITHUB_APP_ID', key: 'GITHUB_APP_PRIVATE_KEY' },
  connect: { id: 'GITHUB_CONNECT_APP_ID', key: 'GITHUB_CONNECT_APP_PRIVATE_KEY' },
};

/** A row's `config.app` as the App that signs for it. Absent means tools; anything else is not an App. */
export const githubAppOfConfig = (value: unknown): GitHubAppName | null => {
  if (value === undefined || value === null) return 'tools';
  return GITHUB_APP_NAMES.includes(value as GitHubAppName) ? value as GitHubAppName : null;
};

/** The App's id and key, or null when either is unset (or the name is not an App). */
export const githubAppCredentials = (
  app: GitHubAppName,
  env: NodeJS.ProcessEnv = process.env,
): { id: string; key: string } | null => {
  if (!GITHUB_APP_NAMES.includes(app)) return null;
  const names = APP_ENV[app];
  const id = String(env[names.id] || '').trim();
  const key = String(env[names.key] || '');
  return id && key.trim() ? { id, key } : null;
};

export const isGithubAppConfigured = (app: GitHubAppName, env: NodeJS.ProcessEnv = process.env): boolean => (
  githubAppCredentials(app, env) !== null
);
