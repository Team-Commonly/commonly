// How the walk gets its account (TASK-706, TASK-729). Staging needs a verified
// email, which a walk address cannot receive, so SRE pre-verifies one shared walk
// account there and the walk signs in to it instead. Prod has no signup for the
// walk: it signs in to an existing test account, and that account is never
// deleted. Signup runs only on non-prod targets with no account given.
// Credentials come from env only. Exact host and https only: a substring match
// would send a shared password to any host whose name contains "staging".
const STAGING_HOSTS = new Set(['api-staging.commonly.me']);
const PROD_HOSTS = new Set(['api.commonly.me']);

// `deleteAccount` is the one value main() hands to cleanup, so the mode decides
// the account's fate here and nowhere else. The password is always COMMONLY_WALK_PASSWORD.
export const chooseWalkMode = ({ base, env }) => {
  const url = new URL(base);
  const email = env.COMMONLY_WALK_EMAIL || '';
  // Checked before the prod branch: over plain http the signup path would send the password in cleartext.
  if (PROD_HOSTS.has(url.hostname) && url.protocol !== 'https:') throw new Error('prod walk requires https; refusing before any request');
  if (url.protocol === 'https:' && PROD_HOSTS.has(url.hostname)) {
    if (!email) throw new Error('prod has no walk signup: set COMMONLY_WALK_EMAIL to an existing test account');
    return { mode: 'signin-prod', email, deleteAccount: false };
  }
  if (!email) return { mode: 'signup', deleteAccount: true };
  if (url.protocol !== 'https:' || !STAGING_HOSTS.has(url.hostname)) {
    throw new Error('COMMONLY_WALK_EMAIL is set but the target is not the staging API over https; the shared sign-in account exists on staging only');
  }
  return { mode: 'signin', email, deleteAccount: false };
};
