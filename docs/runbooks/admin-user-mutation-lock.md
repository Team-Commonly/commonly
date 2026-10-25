# Administrator user mutation lock

Online administrator role changes, account bans and administrative user deletion
and the applying synthetic-account purge share one Mongo lock. The handler
acquires it before re-reading the actor,
reading the target, counting administrators and writing the change. A competing
request receives HTTP 503 `ADMIN_MUTATION_BUSY` and can retry. Role/deletion
writers still enforce their last-administrator and self-change rules. An actor
who passed authentication before losing their role is refused inside the lock.

The lock uses Mongo's unique `_id` (`global-admin-user-mutations`) in
`admin_user_mutation_locks`, with a random owner and acquisition timestamp.
Acquisition and release require majority write acknowledgement. This works on
standalone Mongo as well as replica sets; it requires no multi-document
transaction. It serializes supported online handlers, not direct database edits
or offline maintenance scripts. Run those only with online writers stopped.

There is deliberately no TTL, expiry or automatic takeover. A paused worker can
resume and write its User row after an expiring lease has been stolen. A
separate lock document cannot fence that write on standalone Mongo. Preserving
an administrator takes precedence over automatically recovering mutation
availability. A worker crash, a callback failure or an uncertain database acknowledgement may leave
this small lock row behind. Each caller signals before its first write, including
delegated cleanup. Failures before that signal release the lock; failures after
it retain the lock because a rejected write may still complete later. Known
pre-write authorization refusals also release it safely. Reads and unrelated application work continue;
administrator role, ban and deletion writes fail closed until recovery.

## Deploying the change

Older binaries do not honor this lock. Pause administrator user writes and the
synthetic-account purge during the rollout, drain old writers and their pending
database operations, and enable them only after every API and purge worker uses
the guarded version. A mixed-version deployment does not provide serialization.
Direct database role edits and offline maintenance also require quiescence.

## Recover a persistent busy response

1. Confirm the lock row and record its exact `owner` value and `acquiredAt`.
   A recent row can simply be a request still in flight. Age alone never proves
   that a writer is dead.
2. Stop **all API processes, scheduler/purge workers and maintenance commands that can perform these user mutations** on
   every instance using this database. Confirm that the original holder cannot
   resume, and drain or cancel its server-side database operations. Verify no
   writes from those connections remain in flight. Stopping a process alone
   does not prove that an already submitted database write has finished. An HTTP timeout, an expired pod lease or a disconnected client is
   insufficient. If quiescence cannot be established, leave the lock in place.
3. Inspect the current User rows and administrator count. A failed response can
   have committed its User change before release failed; do not blindly repeat
   the old mutation. If no usable administrator exists because of a historical
   defect or out-of-band edit, restore one while writers remain stopped.
4. Delete the lock using both its fixed `_id` and the recorded `owner` as the
   selector. Do not bulk-delete this collection. Confirm exactly one row was
   removed, or investigate a changed owner before proceeding.
5. Restart the writers and verify a single authorized mutation and the remaining
   administrator count. Resume ordinary traffic only after this succeeds.

Any future online writer that can remove an administrator, ban an account or
promote a deletion target must use the same critical section. A self-serve
account-deletion path may instead refuse administrators and use atomic target
predicates to exclude a concurrent promotion. Tests must exercise that boundary
when integrating the two changes.

The scheduled synthetic-account purge shares the lock for its applying pass,
excludes administrator candidates and preserves administrator bot rows. A dry
run does not acquire the lock. A long purge can temporarily refuse administrator
mutations; a failed purge uses the same crash-recovery procedure.
