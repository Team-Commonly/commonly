// How the walk gets its account (TASK-706, TASK-729). Staging needs a verified
// email, which a walk address cannot receive, so SRE pre-verifies one shared walk
// account there and the walk signs in to it instead. Prod has no signup for the
// walk: it signs in to one existing test account, and that account is never
// deleted. Fresh signup runs only on staging-less targets with no account given.
// Credentials come from env only. Exact host and https only: a substring match
// would send a shared password to any host whose name contains "staging".
const STAGING_HOSTS = new Set(['api-staging.commonly.me']);
const PROD_HOSTS = new Set(['api.commonly.me']);

// `deleteAccount` is the one value main() hands to cleanup, so the mode decides
// the account's fate here and nowhere else. `password` is set only for prod, where
// the walk's own password is not the account's; other modes read COMMONLY_WALK_PASSWORD.
export const chooseWalkMode = ({ base, env }) => {
  const url = new URL(base);
  const isProd = url.protocol === 'https:' && PROD_HOSTS.has(url.hostname);
  if (isProd) {
    if (env.COMMONLY_WALK_EMAIL) throw new Error('COMMONLY_WALK_EMAIL is the shared sign-in account, which exists on staging only; refused on prod');
    if (!env.COMMONLY_WALK_PROD_EMAIL) throw new Error('prod has no walk signup: set COMMONLY_WALK_PROD_EMAIL to an existing test account');
    return { mode: 'signin-prod', email: env.COMMONLY_WALK_PROD_EMAIL, password: env.COMMONLY_WALK_PROD_PASSWORD || '', deleteAccount: false };
  }
  const email = env.COMMONLY_WALK_EMAIL || '';
  if (!email) return { mode: 'signup', deleteAccount: true };
  if (url.protocol !== 'https:' || !STAGING_HOSTS.has(url.hostname)) {
    throw new Error('COMMONLY_WALK_EMAIL is set but the target is not the staging API over https; the shared sign-in account exists on staging only');
  }
  return { mode: 'signin', email, deleteAccount: false };
};
