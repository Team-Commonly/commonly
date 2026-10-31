// Cleanup for one first-user walk run (TASK-706). It runs with the walk
// account's own token, because that is the only authority a run has, and it
// removes what that token can reach: the hosted seat, each pod the account
// created, then the account. Anything it cannot remove is reported by class
// in `survivors`, so the caller fails loudly instead of leaving it silent.
//
// Left for the admin purge, by design: Scout's per-user bot and the hosted
// agent's own User. Account deletion keeps independent agent users, so the
// run records their ids in the manifest and SRE purges them from there.

const ids = (value) => (Array.isArray(value) ? value : value?.pods || []);

// GET /api/pods returns createdBy either as an id or as a populated
// { _id, ... } object, depending on the route. Accept both.
const ownerOf = (pod) => String(pod.createdBy?._id ?? pod.createdBy ?? '');

// `api` is the walk's request helper: (method, path, { token, body }) => { status, data }.
// `podIds` are the pods the walk recorded as created in its manifest. They are
// removed and verified even when the owner match misses them, so a filter
// miss cannot turn into a silent survivor.
export const cleanupRun = async ({ api, token, password, email, userId, agentName, podIds = [] }) => {
  const survivors = [];

  const listOwnPods = async () => {
    const list = await api('GET', '/api/pods', { token });
    return ids(list.data).filter((pod) => ownerOf(pod) === String(userId));
  };

  // Pods only: the walk never joins a pod it did not create, so every pod
  // whose createdBy is this account is the run's own footprint. Bot members
  // are read before the delete, because they outlive the account and the
  // admin purge needs their ids.
  const botIds = new Set();
  const known = new Set(podIds.map(String));
  for (const pod of await listOwnPods()) known.add(String(pod._id));
  for (const id of known) {
    const detail = await api('GET', `/api/pods/${id}`, { token });
    for (const member of detail.data?.members || []) {
      if (member?.isBot) botIds.add(String(member._id));
    }
    await api('DELETE', `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${id}?instanceId=default`, { token });
    const removed = await api('DELETE', `/api/pods/${id}`, { token });
    if (removed.status >= 300 && removed.status !== 404) survivors.push(`pod:${id} (delete ${removed.status})`);
  }

  // Verify rather than trust the delete responses: a pod that is still
  // listed under this account, or still readable by id, is a survivor
  // whatever the delete said.
  for (const pod of await listOwnPods()) survivors.push(`pod:${String(pod._id)} (still listed)`);
  for (const id of known) {
    const after = await api('GET', `/api/pods/${id}`, { token });
    if (after.status === 200) survivors.push(`pod:${id} (still readable)`);
  }

  const del = await api('DELETE', '/api/users/me', { token, body: { password, confirmation: 'DELETE' } });
  if (del.status >= 300) {
    survivors.push(`account (delete ${del.status})`);
  } else {
    // The delete reply is not proof: the account is gone only if its own
    // password no longer logs in.
    const login = await api('POST', '/api/auth/login', { body: { email, password } });
    if (login.status === 200) survivors.push('account (still logs in)');
  }

  return { ok: survivors.length === 0, survivors, botIds: [...botIds] };
};
