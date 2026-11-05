# PG mirror repair (F183)

MongoDB is the source of truth for pods, pod membership and users. PostgreSQL
holds three mirrors that the PG chat path reads:

| PG table | Mirrors | Read by |
|---|---|---|
| `pods` | Mongo `Pod` name, description, type, `createdBy` → `created_by` | PG listings, the message FK |
| `pod_members` | Mongo `Pod.members` | PG listings |
| `users` | Mongo `User`: `username` holds `AgentIdentityService.chatUsernameFor()` (the chat label, a bot's `botMetadata.displayName`), plus `profile_picture`, `is_bot` | the message author join |

**No permission decision reads a mirror.** Message delete judges the owner from
Mongo `Pod.createdBy` (`pgMessageController.deleteMessage`, F183); membership
comes from Mongo `Pod.members` (`isPodMemberInMongo`, `podWriteAccessService`,
TASK-162). A new permission check that reads PG `pods.created_by` or
`pod_members` reintroduces the bug F183 fixed: on 2026-11-05, 39 production pods
had a PG owner Mongo disagreed with, so a wrong owner could delete other
people's messages and the real owner could not.

## Writing to Mongo? Write the mirror too

Every Mongo write that adds or removes a pod member, or creates a pod, follows
with a best-effort mirror write from `services/pgMirrorWrite.ts`:
`mirrorMemberAdded`, `mirrorMemberRemoved`, `mirrorPodCreated`,
`mirrorPodRenamed`, and `mirrorUser` after every User creation (signup, OAuth
signup, `getOrCreateAgentUser`, local dev login). They never throw; a PG failure is logged as `[pg-mirror]`
and the nightly job converges it. User label changes go through
`AgentIdentityService.syncUserToPostgreSQL`.

`__tests__/unit/services/pgMirrorWriteSites.test.js` scans `controllers/`,
`routes/` and `services/` for Mongo member mutations and pod creations without a
mirror write nearby, and for User creations without `mirrorUser` /
`syncUserToPostgreSQL`. A new site fails it until it mirrors, or until it is added
to `ALLOWED` with the reason the mirror may lag.

## What caused the 2026-11-05 drift

- **`created_by` (39 rows).** All 39 pods were created 2026-03-02..07-24,
  before #766 (2026-07-27) made the lazy PG backfill take the owner from Mongo
  instead of the requester; 25 of the 39 stale owners were minted after the pod
  itself. Nothing in Mongo changes `createdBy` after creation. The one live
  writer left was the global social-feed pod backfill
  (`routes/admin/globalIntegrations.ts`, `ensureGlobalPodPostgresSync`), which
  named the admin who triggered it; it now uses `pod.createdBy`.
- **Memberships and pods.** Join, leave, invite redemption, community
  auto-join, mention auto-join, persona hire, agent install, the approval
  `create_pod` join, signup's workspace pod and Scout seat, and themed-pod
  creation wrote Mongo only. Each now mirrors.
- **Ghosts.** `PGPod.create` inserts its owner into `pod_members`;
  `syncPodFromMongo` now removes that row when Mongo does not list the owner.
- **Names.** Pod rename (`PATCH /api/pods/:id/name`) and the
  `rename-agent-dm-pods` / `dedupe-agent-display-names` scripts wrote Mongo
  only (or name without description). They now mirror.

## The nightly job

`services/pgMirrorRepairService.ts`, scheduled by `schedulerService` at
**03:30 UTC** when `PG_MIRROR_REPAIR=true` (Helm `backend.env.pgMirrorRepair`).

- **Report-only** unless `PG_MIRROR_REPAIR_APPLY=1` (Helm
  `backend.env.pgMirrorRepairApply: "1"`). Turn on report-only first and read
  a night's `[pg-mirror-repair]` lines before applying.
- Mongo → PG only. A session advisory lock `(313, 183)` stops two runs
  overlapping; the second logs `skipped` and writes nothing.
- **Never deletes** a PG pod or user Mongo lacks. A PG-only pod is logged with
  its message count (`messages.pod_id` cascades on delete). A PG-only user named
  `Deleted user` with no picture is the account-deletion tombstone and counts
  as explained.
- Ghost memberships are deleted only through the fail-closed classifier in
  `services/podMemberClassifier.ts` (`classifyMemberRows`, shared with `scripts/cleanup-ghost-pod-members.ts`); if any pod
  cannot be read, no ghost is deleted.
- One `[pg-mirror-repair] repair …` line per change with the before-value. Pod
  fields are logged verbatim so a bad run can be undone; user labels and
  pictures are fingerprinted (`sha256:…`). No email is read.
- One row per run in `pg_mirror_repair_runs` (migration 0008): `counts` (drift
  observed before repair), `unexplained`, `mismatch_keys`, `error`. A row with
  `finished_at` NULL is an interrupted run.

**Unexplained** = orphan pods + non-tombstone orphan users + failed repairs +
unreadable pods + **repeats**: a `table:id:field` that differs again the night
after an *applied* run, which means a live writer bypasses the mirror. Find it
with the id and field in the `repeat` log line.

**Alerts** go out as an ERROR line tagged `[pg-mirror-alert]` and a post to
SRE's alerts pod (`spendAlarmService.pageSre`, `SPEND_ALARM_POD_ID`) when any
`created_by` differs, any category grows by more than 20 over the previous run,
there is any repeat, or the run fails. With no pod configured the log line
stands alone.
