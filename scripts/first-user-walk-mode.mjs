// How the walk gets its account (TASK-706). Prod signs up a fresh account every
// run. Staging needs a verified email, which a walk address cannot receive, so
// SRE pre-verifies one shared walk account there and the walk signs in to it
// instead. Its credentials come from env only, and that account is never deleted.
export const chooseWalkMode = ({ base, env }) => {
  const email = env.COMMONLY_WALK_EMAIL || '';
  if (!email) return { mode: 'signup' };
  const host = new URL(base).hostname;
  if (!/staging/.test(host)) {
    throw new Error('COMMONLY_WALK_EMAIL is set but the target is not staging; the shared sign-in account exists on staging only');
  }
  return { mode: 'signin', email };
};
