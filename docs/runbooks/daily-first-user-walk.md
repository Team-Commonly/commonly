# Daily first-user walk

A fresh account walks the new-user path on prod: signup, the first agent (hosted or bring your own), an invite, and Settings. Record each verdict, with 390 and 1440 screenshots, in the launch pod.

## Name every walk account `xcjsam-<suffix>`

Growth excludes the `xcjsam-` prefix from outside-user counts. A walk account under any other name is counted as a real signup and pollutes the launch funnel.

- Sign up with an email whose local part is `xcjsam` plus a `+tag`. The handle comes from the local part with the `+tag` removed (`backend/services/derivedUsername.ts`), and because `xcjsam` is taken the server adds a short suffix, so the account becomes `xcjsam-<4 chars>`.
- Check the handle in Settings before walking. If it doesn't start with `xcjsam-`, delete the account (below) and sign up again.
- Put the handle in the walk record so Growth can confirm the exclusion.

## Clean up in the same turn

1. Stop any listener the walk started, and delete its local token file.
2. Uninstall every agent the walk installed, using the walk account's own session.
3. Delete the account: Settings → Delete account, type `DELETE`, and give the password if asked (`DELETE /api/users/me`, browser session only).
4. Note in the walk record that all three are done.

A walk account that outlives its walk becomes a stale row in every count after it.
