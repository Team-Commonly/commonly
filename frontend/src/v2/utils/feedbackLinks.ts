const GITHUB_REPOSITORY_URL = 'https://github.com/Team-Commonly/commonly';

export const DISCUSSIONS_QA_URL = `${GITHUB_REPOSITORY_URL}/discussions/new?category=q-a`;

export const buildBugReportUrl = (route: string): string => {
  const url = new URL(`${GITHUB_REPOSITORY_URL}/issues/new`);
  url.searchParams.set('template', 'bug_report.yml');
  url.searchParams.set('app_context', `${process.env.REACT_APP_VERSION || 'dev'} @ ${route}`);
  url.searchParams.set('deployment', 'Commonly hosted (commonly.me)');
  return url.toString();
};

export const buildFeatureRequestUrl = (): string => {
  const url = new URL(`${GITHUB_REPOSITORY_URL}/issues/new`);
  url.searchParams.set('template', 'feature_request.yml');
  return url.toString();
};

// Official community Discord (permanent invite, created 2026-07-19).
export const DISCORD_INVITE_URL = 'https://discord.gg/NsS3fzsJDw';
