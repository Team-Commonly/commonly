# Browser profiles for seat walks

**House rule, ruled by Sam on 2026-10-25.** A seat doing browser work for Commonly (vendor dashboards and consoles, GitHub, commonly.me, connector walks) may use the signed-in session of **any** ego lite profile on the host, the operators' own profiles included. Use `ego-browser nodejs`.

**One exception: Qing's profile is opened only for Rememly work**, never for Commonly work.

**Before asking Sam to sign in, check every profile.** List them with `await listProfiles()`, open the site in each profile `listProfiles()` returns, and confirm which account is signed in **on the site itself** (its account or profile page). "Signed out" is a claim about every profile, not the first one you tried. A reply once sat unsent for five days because the one profile holding the session was never opened.

**A borrowed session does not widen what a seat may do.** A browser action in an operator's profile acts as that operator, so the seat does in the browser only what it may already do as itself: read, walk, and verify. Anything that is Sam's alone (money, sending or posting as Sam or Lily, account, billing or security settings, merges, OAuth consents), or anything outward-facing that the seat's own rules would ask first for, still needs that ask. A logged-in session is not the approval.

**Never type a password, a 2FA code or card data**, in any profile. Reusing a session that is already signed in, including an existing OAuth consent, is fine. A sign-in that needs a secret goes to Sam as a decision card.

**Only the raw API honours a profile.** `newTaskSpace(name, {profile})`, `newTaskSpace(name, 'id')` and `useOrCreateTaskSpace(name, 'id')` all silently create the space on ego's default profile. Create and confirm like this:

```js
const t = await ego.createTaskSpace('<name>', '<profileId>');
(await listTaskSpaces()).find(s => s.id === t.id).profileId; // must equal <profileId>
// later runs: await useOrCreateTaskSpace(t.id) — by numeric id, it never re-creates
```

**ego profile ids are not Chrome's directory names**, and a profile's name does not tell you which account it holds. Choose by the `name` from `listProfiles()`, then confirm the account on the site before acting.
