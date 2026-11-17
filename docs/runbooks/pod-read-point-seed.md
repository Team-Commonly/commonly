# Seeding first pod read points

Pod read points (#4150, `pod_read_points`, migration 0014) drive the "New since your last visit" divider when a person opens a pod. They start empty. With no row, the pod opens at its end and shows no divider, so without a seed nobody's first return after the feature shipped would show one.

## The seed

`services/podReadPointSeed.ts` fills a member's slot once, from the best signal we already hold:

1. the later of their thread read point (`thread_user_state.last_read_at`) and their last message in that pod, because both show they were there;
2. else their account's `lastActive`;
3. else nothing.

The seed is never later than now. It uses `INSERT … ON CONFLICT DO NOTHING`, so it never moves a real read point, earlier or later, and running it again changes nothing.

## Two paths

- **Lazy, on `GET /api/pods/:id/read-point`.** A member with no row gets a seed from step 1 only. `touchLastActive` in the auth middleware has just moved `lastActive` to now on the request that opened the pod, so reading it there would seed "now" and show nothing.
- **One-off, `scripts/seed-pod-read-points.ts`.** Covers every human member of every pod, with `lastActive` as the fallback. Run it on the ops-runner right after the deploy that ships the seed, before people come back and move their `lastActive`. It's a dry run by default and prints counts only:

  ```
  node dist/scripts/seed-pod-read-points.js
  node dist/scripts/seed-pod-read-points.js --apply
  ```

  A member who opened a pod between the deploy and the run already has a real row, and the script skips it.

## Limits

- System lines filed under a person's id are left out, because a decline or a task claim is made from outside the pod.
- `lastActive` is account-wide, not per pod. It is usually later than a member's last look at a given pod, so a seed from it can hide messages they never saw. It is used only when the member has done nothing in that pod.
- A message a person posted through their API token or the CLI counts as presence, even though they may not have read the channel.
- A seed far in the past can still show no divider. The page shows none when older history isn't loaded and every loaded message is newer than the point.
