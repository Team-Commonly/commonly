// Cleanup for one first-user walk run (TASK-706). It runs with the walk
// account's own token, because that is the only authority a run has, and it
// removes what that token can reach: the hosted runtime, the seat, each pod the
// account created, then the account. Anything it cannot remove or cannot
// confirm is reported by class in `survivors`, so the caller fails loudly
// instead of leaving it silent.
//
// Left for the admin purge, by design: Scout's per-user bot and the hosted
// agent's own User. Account deletion keeps independent agent users, so the
// run records their ids in the manifest and SRE purges them from there.

const ids = (value) => (Array.isArray(value) ? value : value?.pods || []);

// GET /api/pods returns createdBy either as an id or as a populated
// { _id, ... } object, depending on the route. Accept both.
export const ownerOf = (pod) => String(pod.createdBy?._id ?? pod.createdBy ?? '');

// Only the bots this run created go in the manifest: the hosted agent (its
// username carries this run's agent name) and the per-user Scout (`scout-u…`).
// The shared default bot is a member of every new pod and is never recorded,
// because SRE's purge would delete an identity every pod uses. `scout: false`
// is for a kept account: its Scout is that account's own bot, not this run's.
export const isRunBot = (member, agentName, { scout = true } = {}) => {
  const name = String(member?.username || '');
  const isScout = scout && name.startsWith('scout-u');
  return member?.isBot === true && (name === agentName || name.startsWith(`${agentName}-`) || isScout);
};

// After an ambiguous pod create (an error, or a reply without an id), the pod
// may exist. Find this run's pods by their unique name and record them, so
// cleanup removes them. Returns true only when a matching pod is found. It
// returns false when the list cannot be read or holds no match, and the caller
// must report the name as an unresolved survivor. An empty match would let
// cleanup mark the run clean while the pod is still live.
export const recoverRunPods = async ({ api, token, userId, podName, podIds }) => {
  try {
    const list = await api('GET', '/api/pods', { token });
    // A 200 whose body is not a pod list is unreadable, not an empty list.
    if (list.status !== 200 || !(Array.isArray(list.data) || Array.isArray(list.data?.pods))) return false;
    let found = false;
    for (const p of ids(list.data)) {
      if (p.name === podName && ownerOf(p) === String(userId)) {
        found = true;
        if (!podIds.includes(String(p._id))) podIds.push(String(p._id));
      }
    }
    return found;
  } catch {
    return false;
  }
};

// `api` is the walk's request helper: (method, path, { token, body }) => { status, data }.
// `podIds` are the pods the walk recorded as created in its manifest. They are
// removed and verified even when the owner match misses them, so a filter
// miss cannot turn into a silent survivor. `onBotIds(podId, botIds)` is called
// before each pod is deleted, so a throw later in the loop cannot lose the ids.
// `deleteAccount: false` is the shared staging sign-in account: the run removes
// only the pods it recorded, never pods that account owns from elsewhere, and
// never the account itself.
export const cleanupRun = async ({ api, token, password, email, userId, agentName, podIds = [], onBotIds = () => {}, deleteAccount = true, hostedOptional = false }) => {
  const survivors = [];
  const botIds = new Set();

  const listOwnPods = async () => {
    const list = await api('GET', '/api/pods', { token });
    if (list.status !== 200) return null;
    return ids(list.data).filter((pod) => ownerOf(pod) === String(userId));
  };

  // Stop the runtime before the seat goes: uninstalling the seat does not stop
  // the hosted worker. 404 means there was no hosted install to stop. On a staging
  // run where provisioning was skipped (hostedOptional), the backend answers
  // deprovision with the same not-ready code (503 unconfigured / 502 unreachable):
  // nothing was provisioned, so that is not a leaked runtime and must not become a
  // survivor that reddens the run. On prod the agent WAS provisioned, so a failed
  // deprovision stays a survivor.
  const stop = await api('POST', '/api/hosted/deprovision', { token, body: { agentName } });
  const stopNotReady = hostedOptional
    && (stop.data?.code === 'hosted_runtime_unconfigured' || stop.data?.code === 'hosted_runtime_unreachable');
  if (stop.status >= 300 && stop.status !== 404 && !stopNotReady) survivors.push(`hosted:${agentName} (deprovision ${stop.status})`);

  let owned = [];
  if (deleteAccount) {
    owned = await listOwnPods();
    if (owned === null) {
      survivors.push('pods (list failed)');
      owned = [];
    }
  }
  const known = new Set(podIds.map(String));
  for (const pod of owned) known.add(String(pod._id));

  // Pods only: the walk never joins a pod it did not create, so every pod
  // whose createdBy is this account is the run's own footprint. Bot members
  // are read before the delete, because they outlive the account and the
  // admin purge needs their ids. A lookup that fails is a survivor, and the
  // pod is left alone: an empty member list must never read as "no bots".
  for (const id of known) {
    const detail = await api('GET', `/api/pods/${id}`, { token });
    if (detail.status === 404) continue;
    if (detail.status !== 200) {
      survivors.push(`pod:${id} (lookup ${detail.status})`);
      continue;
    }
    const bots = (detail.data?.members || []).filter((m) => isRunBot(m, agentName, { scout: deleteAccount })).map((m) => String(m._id));
    bots.forEach((bot) => botIds.add(bot));
    onBotIds(id, bots);

    const seat = await api('DELETE', `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${id}?instanceId=default`, { token });
    if (seat.status >= 300 && seat.status !== 404) survivors.push(`seat:${id} (uninstall ${seat.status})`);
    const removed = await api('DELETE', `/api/pods/${id}`, { token });
    if (removed.status >= 300 && removed.status !== 404) survivors.push(`pod:${id} (delete ${removed.status})`);
  }

  // Verify rather than trust the delete responses: a pod that is still
  // listed under this account, or still readable by id, is a survivor
  // whatever the delete said. A list that fails here cannot prove the pods
  // are gone, so it is a survivor too.
  if (deleteAccount) {
    const after = await listOwnPods();
    if (after === null) survivors.push('pods (list failed on verify)');
    for (const pod of after || []) survivors.push(`pod:${String(pod._id)} (still listed)`);
  }
  for (const id of known) {
    const check = await api('GET', `/api/pods/${id}`, { token });
    if (check.status === 200) survivors.push(`pod:${id} (still readable)`);
    else if (check.status !== 404) survivors.push(`pod:${id} (verify ${check.status})`);
  }

  if (deleteAccount) {
    const del = await api('DELETE', '/api/users/me', { token, body: { password, confirmation: 'DELETE' } });
    if (del.status >= 300) {
      survivors.push(`account (delete ${del.status})`);
    } else {
      // The delete reply is not proof: the account is gone only if its own
      // password no longer logs in.
      const login = await api('POST', '/api/auth/login', { body: { email, password } });
      if (login.status === 200) survivors.push('account (still logs in)');
    }
  }

  return { ok: survivors.length === 0, survivors, botIds: [...botIds] };
};
